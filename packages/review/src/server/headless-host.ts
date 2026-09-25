import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { isObjectValue } from "@dev.fast/json";
import {
  traceMachineEnabled,
  withFileLock,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import { createAdaptorServer, upgradeWebSocket } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { ReviewInputError } from "../review-api/document.js";
import { createReviewApi } from "../review-api/http.js";
import { openReviewProfile } from "../review-api/profile.js";
import { readScratchpadEnabled } from "../review-preferences.js";
import {
  type ReviewServerDiscovery,
  reviewServerDiscoveryPath,
} from "../server-discovery.js";
import { mountSharingPublisher } from "../sharing/host.js";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import {
  type ReviewHonoEnv,
  isAuthorizedRequest,
  readBoundedRequestJson,
} from "./hono-http.js";
import {
  drainServerCrashReport,
  installProcessErrorTelemetry,
} from "./process-error-telemetry.js";
import type { ReviewTelemetryCapture } from "./ui-telemetry.js";

const WHITEBOARD_DESKTOP_ORIGIN = "vscode-file://vscode-app";
const HEADLESS_CORS_METHODS = "GET, HEAD, POST, OPTIONS";
const HEADLESS_CORS_HEADERS =
  "content-type, x-review-token, x-review-app-session-id";

function applyWhiteboardDesktopCors(
  request: Request,
  response: Response,
): Response {
  const vary = response.headers.get("vary");
  const varyFields = vary
    ?.split(",")
    .map((field) => field.trim().toLowerCase());

  if (!varyFields?.includes("*") && !varyFields?.includes("origin")) {
    response.headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  }

  if (request.headers.get("origin") !== WHITEBOARD_DESKTOP_ORIGIN) {
    return response;
  }

  response.headers.set("access-control-allow-origin", WHITEBOARD_DESKTOP_ORIGIN);
  response.headers.set("access-control-allow-methods", HEADLESS_CORS_METHODS);
  response.headers.set("access-control-allow-headers", HEADLESS_CORS_HEADERS);
  response.headers.set("access-control-allow-private-network", "true");
  return response;
}

interface HeadlessServerInput {
  stateDir: string;
  port?: number;
  softwareMapEnabled?: boolean;
  token?: string;
  signal: AbortSignal;
  /** The CLI's instance, already on the `headless` surface. */
  telemetry?: Pick<ReviewTelemetryCapture, "captureUiEvent">;
  onReady(discovery: ReviewServerDiscovery): void;
}

/** One foreground headless endpoint per profile; Desktop shares its database. */
export async function runHeadlessServer(input: HeadlessServerInput) {
  await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(input.stateDir);

  const stopErrorTelemetry =
    input.telemetry && installProcessErrorTelemetry(input.telemetry);

  const outcome = await withFileLock(
    path.join(stateDir, "headless-server.lock"),
    {
      timeoutMs: 0,
      retryMs: 20,
      // A paused live owner must never lose exclusive access to its store.
      staleMs: Infinity,
      unownedGraceMs: 1_000,
    },
    () => serve({ ...input, stateDir }),
  ).finally(() => stopErrorTelemetry?.());

  if (!outcome.acquired)
    throw new Error(
      `A Review server already owns ${stateDir}. Stop it first, or choose another --state-dir.`,
    );
}

async function serve(input: HeadlessServerInput) {
  if (input.signal.aborted) return;

  if (input.telemetry) await drainServerCrashReport(input.telemetry);

  const local = await openReviewProfile(input.stateDir, {
    manageWorkspaces: false,
  });

  const relay = new GlobalReviewDesktopVerbRelay();
  const discovery: ReviewServerDiscovery = {
    version: 1,
    instanceId: randomUUID(),
    url: "http://127.0.0.1:0",
    serverPid: process.pid,
    token: input.token ?? randomBytes(32).toString("base64url"),
  };

  const app = new Hono<ReviewHonoEnv>();
  app.use("*", async (context, next) => {
    await next();
    applyWhiteboardDesktopCors(context.req.raw, context.res);
  });
  app.options("*", (context) =>
    applyWhiteboardDesktopCors(
      context.req.raw,
      new Response(null, {
        status:
          context.req.raw.headers.get("origin") === WHITEBOARD_DESKTOP_ORIGIN
            ? 204
            : 403,
      }),
    ),
  );
  app.use("*", async (context, next) => {
    if (!isAuthorizedRequest(context.req.raw, discovery.token))
      return context.json({ error: "Unauthorized" }, 401);
    await next();
  });
  app.get("/health", (context) =>
    context.json({ ok: true, instanceId: discovery.instanceId }),
  );
  app.get("/control", (context) => openControlEvents(context));
  app.post("/control/result", async (context) => {
    const accepted = relay.acceptResult(
      await readBoundedRequestJson(context.req.raw),
    );

    return context.json({ ok: accepted }, accepted ? 200 : 404);
  });
  app.get(
    "/health/websocket",
    upgradeWebSocket(() => ({
      onOpen(_event, webSocket) {
        webSocket.close(1000);
      },
    })),
  );

  // Headless shares Desktop's database, so it lists the pad on the same
  // terms; a preference changed after start applies at the next start.
  const scratchpadEnabled = await readScratchpadEnabled();

  const api = createReviewApi(
    local.store,
    local.data,
    async (review) => {
      if (!relay.attached)
        throw new ReviewInputError("The desktop is not connected.", 409);

      const result = await relay.dispatch({
        name: "openApiReview",
        args: review,
      });

      if (!result.ok) throw new ReviewInputError(result.error, 409);

      return z
        .object({ softwareMapEnabled: z.boolean() })
        .parse(result.result);
    },
    undefined,
    async () => {
      if (!relay.attached)
        return {
          desktopAvailable: false,
          softwareMapEnabled: input.softwareMapEnabled ?? false,
        };

      const result = await relay.dispatch({
        name: "authoringCapabilities",
        args: {},
      });

      if (!result.ok) throw new ReviewInputError(result.error, 409);

      return {
        desktopAvailable: true,
        ...z.object({ softwareMapEnabled: z.boolean() }).parse(result.result),
      };
    },
    () => scratchpadEnabled,
    () => traceMachineEnabled(),
    () => ({ key: "headless", home: input.stateDir }),
  );

  mountSharingPublisher(api, local.store, local.data);
  app.route("/reviews-api", api);

  function openControlEvents(context: Context<ReviewHonoEnv>): Response {
    if (relay.attached)
      return context.json(
        {
          ok: false as const,
          error: "A Review Desktop control client is already attached.",
        },
        409,
      );

    let attached = false;

    const response = streamSSE(context, async (output) => {
      let finish!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const abort = new AbortController();
      let pending: Promise<void> = output
        .write(": attached\n\n")
        .then(() => undefined);
      const writer = {
        signal: abort.signal,
        write(frame: string) {
          pending = pending.then(async () => {
            await output.write(frame);
          });
        },
        close() {
          finish();
          void output.close();
        },
      };

      output.onAbort(() => {
        abort.abort();
        finish();
      });
      attached = relay.attach(writer);

      if (!attached) {
        finish();
        return;
      }

      try {
        await disconnected;
        await pending;
      } finally {
        abort.abort();
      }
    });

    if (!attached) {
      void response.body?.cancel();
      return context.json(
        {
          ok: false as const,
          error: "A Review Desktop control client is already attached.",
        },
        409,
      );
    }

    response.headers.set("cache-control", "no-cache, no-transform");
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    return response;
  }

  const webSocketServer = new WebSocketServer({ noServer: true });

  // SAFETY: createAdaptorServer uses the supplied node:http createServer.
  const server = createAdaptorServer({
    createServer,
    fetch: app.fetch,
    websocket: { server: webSocketServer },
  }) as ReturnType<typeof createServer>;

  let published = false;

  try {
    const listening = once(server, "listening");
    server.listen(input.port ?? 0, "127.0.0.1");
    await listening;
    const address = server.address();

    if (!isObjectValue(address))
      throw new Error("Review server did not bind a TCP port.");
    discovery.url = `http://127.0.0.1:${address.port}`;
    await writePrivateJsonAtomic(
      reviewServerDiscoveryPath(input.stateDir),
      discovery,
    );
    published = true;
    input.onReady(discovery);

    await new Promise<void>((resolve) => {
      if (input.signal.aborted) resolve();
      else
        input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    // Watch streams may live forever. Drain ordinary requests, then bound shutdown.
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();

    try {
      if (published)
        await rm(reviewServerDiscoveryPath(input.stateDir), { force: true });
    } finally {
      relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearTimeout(forceClose);

      try {
        await local.data.close();
      } finally {
        await local.store.close();
      }
    }
  }
}
