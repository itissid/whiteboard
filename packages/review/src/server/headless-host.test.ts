import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";

import { runReviewCli } from "../cli-runner.js";
import {
  connectReviewApi,
  connectReviewInstance,
} from "../review-api/agent-client.js";
import { ReviewApiClient } from "../review-api/client.js";
import type { Pins } from "../review-api/document.js";
import { createReviewApi } from "../review-api/http.js";
import { serveReviewMcp } from "../review-api/mcp.js";
import { openReviewProfile } from "../review-api/profile.js";
import type { Result, Snapshot } from "../review-api/store.js";
import {
  type ReviewServerDiscovery,
  readReviewServerDiscovery,
  reviewServerDiscoveryPath,
  reviewServerIsHealthy,
} from "../server-discovery.js";
import { runHeadlessServer } from "./headless-host.js";

let root: string;

const stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-headless-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function start(
  stateDir = path.join(root, "server"),
  softwareMapEnabled = false,
) {
  const controller = new AbortController();
  const ready = Promise.withResolvers<ReviewServerDiscovery>();

  const running = runHeadlessServer({
    stateDir,
    softwareMapEnabled,
    signal: controller.signal,
    onReady: ready.resolve,
  });

  const stop = async () => {
    controller.abort();
    await running;
  };

  stops.push(stop);

  const discovery = await Promise.race([
    ready.promise,
    running.then(() => {
      throw new Error("Server exited before readiness");
    }),
  ]);

  const env = { ...process.env, DEV_REVIEW_SERVER_DIR: stateDir };
  const client = await connectReviewApi(env);

  return { client, discovery, env, stateDir, stop };
}

async function startCli(
  token: string | undefined,
  stateDir = path.join(root, "server"),
) {
  const env = { ...process.env };

  delete env.DEV_REVIEW_SERVER_TOKEN;

  if (token !== undefined) env.DEV_REVIEW_SERVER_TOKEN = token;

  const child = spawn(
    process.execPath,
    [
      "--import=tsx",
      path.resolve(import.meta.dirname, "../cli.ts"),
      "--state-dir",
      stateDir,
      "server",
      "start",
      "--json",
    ],
    {
      env: {
        ...env,
        DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
      },
    },
  );

  const ready = Promise.withResolvers<void>();
  let output = "";
  let outputBuffer = "";
  let errors = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    outputBuffer += chunk;
    let end: number;

    while ((end = outputBuffer.indexOf("\n")) >= 0) {
      const line = outputBuffer.slice(0, end);
      outputBuffer = outputBuffer.slice(end + 1);

      if (line && JSON.parse(line).event === "server.ready") ready.resolve();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });

  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  child.once("error", ready.reject);
  child.once("exit", (code) => {
    ready.reject(new Error(`Server exited before readiness with code ${code}`));
  });

  await ready.promise;
  const discovery = await readReviewServerDiscovery(stateDir);

  if (!discovery) throw new Error("Server became ready without discovery");

  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  };

  stops.push(stop);

  return {
    discovery,
    errors: () => errors,
    output: () => output,
    stateDir,
    stop,
  };
}

async function webSocketAuthenticationStatus(
  serverUrl: string,
  token: string,
): Promise<number> {
  const url = new URL(
    `/health/websocket?token=${encodeURIComponent(token)}`,
    serverUrl,
  );

  url.protocol = "ws:";

  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url);

    webSocket.once("open", () => {
      webSocket.close();
      resolve(101);
    });
    webSocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    webSocket.once("error", reject);
  });
}

async function repository() {
  const directory = path.join(root, "repo");
  await mkdir(directory);

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review-test@example.invalid");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 1;\n",
  );
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 2;\n",
  );
  git("commit", "-qam", "head");

  return { directory, base, head: git("rev-parse", "HEAD") };
}

async function cli(argv: string[], env: NodeJS.ProcessEnv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let output = "",
    errors = "";

  stdout.on("data", (chunk) => {
    output += chunk;
  });
  stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exitCode = await runReviewCli({ argv, env, stdout, stderr });

  return { exitCode, output, errors };
}

it("shares review identity, resources, sessions and live changes with Desktop in one profile", async () => {
  const repo = await repository();
  const server = await start(root);
  const local = await openReviewProfile(root, { manageWorkspaces: true });
  const opened: string[] = [];

  const app = createReviewApi(local.store, local.data, async ({ reviewId }) => {
    opened.push(reviewId);

    return { softwareMapEnabled: false };
  });

  const desktop = new ReviewApiClient(
    { serverUrl: "http://desktop.test", token: "test" },
    async (url, init) => app.request(url.replace("/reviews-api", ""), init),
  );

  const abort = new AbortController();
  const catalog = desktop.watch(null, abort.signal);
  let reviewStream: ReturnType<ReviewApiClient["watch"]> | undefined;

  try {
    // The scratchpad is off by default, so there is nothing to list yet.
    expect((await catalog.next()).value).toEqual([]);

    const registered = await server.client.post<{ id: string }>(
      "/repositories",
      { path: repo.directory },
    );

    const pins = {
      repositoryId: registered.id,
      base: repo.base,
      head: repo.head,
    };

    const created = await server.client.post<Result>("/commands", {
      commandId: randomUUID(),
      operation: { type: "create", title: "Shared review", pins },
    });

    // Catalog refreshes can also report repository registration before creation.
    for await (const value of catalog) {
      if (
        Array.isArray(value) &&
        value.some((item) => item.reviewId === created.reviewId)
      )
        break;
    }

    reviewStream = desktop.watch(created.reviewId, abort.signal);
    expect((await reviewStream.next()).value).toMatchObject({
      reviewId: created.reviewId,
      version: 0,
    });
    const leaseId = randomUUID();
    await server.client.post(`/${created.reviewId}/activity`, {
      action: "begin",
      leaseId,
    });

    for (;;) {
      const value = (await reviewStream.next()).value;

      if (
        value &&
        !Array.isArray(value) &&
        "activity" in value &&
        value.activity?.workingCount === 1
      )
        break;
    }

    await expect(
      desktop.post("/commands", {
        commandId: randomUUID(),
        operation: {
          type: "rename",
          reviewId: created.reviewId,
          title: "Competing author",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const traceId = randomUUID();
    await server.client.post("/resources", {
      id: traceId,
      repositoryId: registered.id,
      kind: "trace",
      trace: {
        label: "Evidence",
        events: [{ id: "answer", role: "assistant", text: "Shared bytes" }],
      },
    });
    expect(
      await desktop.read(`/${created.reviewId}/resources/${traceId}`),
    ).toMatchObject({
      label: "Evidence",
    });
    await server.client.post("/commands", {
      commandId: randomUUID(),
      leaseId,
      operation: {
        type: "edit",
        reviewId: created.reviewId,
        edit: {
          type: "insert",
          content: {
            type: "trace_quote",
            traceId,
            eventId: "answer",
            text: "Shared bytes",
          },
        },
      },
    });

    for (;;) {
      const value = (await reviewStream.next()).value;

      if (
        value &&
        !Array.isArray(value) &&
        "version" in value &&
        value.version === 1
      )
        break;
    }

    await desktop.post(`/${created.reviewId}/open`, {});
    expect(opened).toEqual([created.reviewId]);
    expect(
      (await desktop.read<Snapshot[]>(""))
        .map((item) => item.reviewId)
        .filter((id) => id !== "scratchpad"),
    ).toEqual([created.reviewId]);
    await server.client.post(`/${created.reviewId}/activity`, {
      action: "end",
      leaseId,
    });
    await desktop.post("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "rename",
        reviewId: created.reviewId,
        title: "Changed in Desktop",
      },
    });
    expect(
      await server.client.read(`/${created.reviewId}?full=true`),
    ).toMatchObject({ title: "Changed in Desktop", version: 2 });
    await server.client.post("/commands", {
      commandId: randomUUID(),
      operation: { type: "delete", reviewId: created.reviewId },
    });
    await expect(async () => {
      for await (const _value of reviewStream!) {
      }
    }).rejects.toThrow(/not found/i);
  } finally {
    abort.abort();
    await local.data.close();
    await local.store.close();
  }
});

it("authors through CLI and MCP without Desktop and retains source, unfinished sections and resources across restart", async () => {
  const repo = await repository();
  const server = await start();
  const client = server.client;

  const registered = await client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  const pins = await client.post<Pins>("/pins", {
    repositoryId: registered.id,
    base: repo.base,
    head: repo.head,
  });

  const created = await cli(
    [
      "--state-dir",
      server.stateDir,
      "api",
      "session_create",
      JSON.stringify({
        commandId: randomUUID(),
        title: "CI review",
        pins,
      }),
    ],
    process.env,
  );

  expect(created).toMatchObject({ exitCode: 0, errors: "" });

  const { sessionId: reviewId } = z
    .object({ sessionId: z.string() })
    .parse(JSON.parse(created.output));

  await client.post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "section",
          title: "Work in progress",
          children: [],
        },
      },
    },
  });
  const imageId = randomUUID();

  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();

  await client.post("/resources", {
    id: imageId,
    repositoryId: registered.id,
    kind: "image",
    base64: image.toString("base64"),
  });
  await client.post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "image",
          assetId: imageId,
          alt: "Retained image",
        },
      },
    },
  });
  const traceId = randomUUID();
  await client.post("/resources", {
    id: traceId,
    repositoryId: registered.id,
    kind: "trace",
    trace: {
      label: "CI author",
      events: [{ id: "one", role: "assistant", text: "Checked the source" }],
    },
  });
  // Existing maps can be uploaded even with generation disabled.
  const mapId = randomUUID();
  await client.post("/resources", {
    id: mapId,
    repositoryId: registered.id,
    kind: "map",
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          containers: {
            api: {
              components: {
                value: {
                  codeElements: {
                    value: {
                      sourceRanges: [
                        { file: "example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  await expect(
    client.post("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "edit",
        reviewId,
        edit: {
          type: "insert",
          content: {
            type: "code_peek",
            source: {
              file: "missing.ts",
              start: { side: "head", line: 1 },
              end: { side: "head", line: 1 },
            },
          },
        },
      },
    }),
  ).rejects.toThrow(/unavailable at the pinned commit/i);
  expect(await client.read<Snapshot>(`/${reviewId}?full=true`)).toMatchObject({
    version: 2,
  });
  await server.stop();
  expect(await readReviewServerDiscovery(server.stateDir)).toBeNull();

  const restarted = await start(server.stateDir);
  expect(
    await restarted.client.read<Snapshot>(`/${reviewId}?full=true`),
  ).toMatchObject({
    reviewId,
    pins,
    document: [{ title: "Work in progress" }, { assetId: imageId }],
  });

  const retained = await restarted.client.response(
    `/${reviewId}/resources/${imageId}`,
  );

  expect(Buffer.from(await retained.arrayBuffer())).toEqual(image);
  expect(
    (await restarted.client.response(`/${reviewId}/resources/${traceId}`))
      .status,
  ).toBe(200);
  expect(
    (await restarted.client.response(`/${reviewId}/resources/${mapId}`)).status,
  ).toBe(200);

  const file = await restarted.client.read<{ text: string }>(
    `/${reviewId}/file?side=head&file=example.ts`,
  );

  expect(file.text).toBe("export const value = 2;\n");

  const stdin = new PassThrough(),
    stdout = new PassThrough();

  const mcp = await serveReviewMcp(
    () => connectReviewInstance(restarted.env),
    stdin,
    stdout,
  );

  const replies: {
    id: number;
    result: { content?: { text: string }[]; isError?: boolean };
  }[] = [];

  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += chunk;
    let end: number;

    while ((end = buffer.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });

  try {
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "CI", version: "1" },
        },
      }) + "\n",
    );
    await expect.poll(() => replies.some((reply) => reply.id === 1)).toBe(true);
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "session_get",
          arguments: { sessionId: reviewId, full: true, format: "json" },
        },
      }) + "\n",
    );
    await expect
      .poll(() => replies.find((reply) => reply.id === 2))
      .toBeTruthy();
    const result = replies.find((reply) => reply.id === 2)!.result;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content![0].text)).toMatchObject({
      sessionId: reviewId,
      version: 2,
    });
  } finally {
    await mcp.close();
  }
});

it("keeps a configured credential valid across CLI server restarts", async () => {
  const token = "restart-stable-token";
  const first = await startCli(token);

  expect(
    (
      await fetch(`${first.discovery.url}/health`, {
        headers: { "x-review-token": token },
      })
    ).status,
  ).toBe(200);
  expect(first.output()).not.toContain(token);
  expect(first.errors()).not.toContain(token);
  await first.stop();

  const restarted = await startCli(token, first.stateDir);
  expect(
    await webSocketAuthenticationStatus(restarted.discovery.url, token),
  ).toBe(101);
  expect(
    (
      await fetch(`${restarted.discovery.url}/health`, {
        headers: { "x-review-token": "invalid-token" },
      })
    ).status,
  ).toBe(401);
  expect(restarted.output()).not.toContain(token);
  expect(restarted.errors()).not.toContain(token);
});

it("rotates a configured credential when the CLI configuration changes", async () => {
  const oldToken = "old-stable-token";
  const first = await startCli(oldToken);
  await first.stop();

  const replacementToken = "replacement-stable-token";
  const rotated = await startCli(replacementToken, first.stateDir);

  expect(
    (
      await fetch(`${rotated.discovery.url}/health`, {
        headers: { "x-review-token": oldToken },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${rotated.discovery.url}/health`, {
        headers: { "x-review-token": replacementToken },
      })
    ).status,
  ).toBe(200);
  expect(
    await webSocketAuthenticationStatus(rotated.discovery.url, oldToken),
  ).toBe(401);
  expect(
    await webSocketAuthenticationStatus(
      rotated.discovery.url,
      replacementToken,
    ),
  ).toBe(101);
  expect(rotated.output()).not.toContain(oldToken);
  expect(rotated.output()).not.toContain(replacementToken);
  expect(rotated.errors()).not.toContain(oldToken);
  expect(rotated.errors()).not.toContain(replacementToken);
});

it("continues to generate process-scoped credentials without configuration", async () => {
  const first = await startCli(undefined);
  const oldToken = first.discovery.token;
  await first.stop();

  const restarted = await startCli(undefined, first.stateDir);
  expect(restarted.discovery.token).not.toBe(oldToken);
  expect(
    (
      await fetch(`${restarted.discovery.url}/health`, {
        headers: { "x-review-token": oldToken },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${restarted.discovery.url}/health`, {
        headers: { "x-review-token": restarted.discovery.token },
      })
    ).status,
  ).toBe(200);
});

it("allows Whiteboard Desktop to preflight authenticated headless requests", async () => {
  const server = await start();
  const response = await fetch(`${server.discovery.url}/health`, {
    method: "OPTIONS",
    headers: {
      origin: "vscode-file://vscode-app",
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-review-token",
    },
  });

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "vscode-file://vscode-app",
  );
  expect(response.headers.get("access-control-allow-methods"))
    .toBe("GET, HEAD, POST, OPTIONS");
  expect(response.headers.get("access-control-allow-headers"))
    .toBe("content-type, x-review-token, x-review-app-session-id");
  expect(response.headers.get("access-control-allow-private-network"))
    .toBe("true");
  expect(response.headers.get("vary")).toContain("Origin");
});

it("does not grant another browser origin access to the headless server", async () => {
  const server = await start();
  const origin = "https://untrusted.example";
  const preflight = await fetch(`${server.discovery.url}/health`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-review-token",
    },
  });

  expect(preflight.status).toBe(403);
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  expect(preflight.headers.get("access-control-allow-methods")).toBeNull();
  expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
  expect(preflight.headers.get("vary")).toContain("Origin");

  const authenticated = await fetch(`${server.discovery.url}/health`, {
    headers: {
      origin,
      "x-review-token": server.discovery.token,
    },
  });

  expect(authenticated.status).toBe(200);
  expect(authenticated.headers.get("access-control-allow-origin")).toBeNull();
  expect(authenticated.headers.get("vary")).toContain("Origin");
});

it("lets Whiteboard Desktop read authenticated and rejected headless responses", async () => {
  const server = await start();
  const origin = "vscode-file://vscode-app";
  const authenticated = await fetch(`${server.discovery.url}/health`, {
    headers: {
      origin,
      "x-review-token": server.discovery.token,
    },
  });

  expect(authenticated.status).toBe(200);
  expect(authenticated.headers.get("access-control-allow-origin")).toBe(origin);
  expect(authenticated.headers.get("vary")).toContain("Origin");

  const rejected = await fetch(`${server.discovery.url}/health`, {
    headers: {
      origin,
      "x-review-token": "invalid-token",
    },
  });

  expect(rejected.status).toBe(401);
  expect(rejected.headers.get("access-control-allow-origin")).toBe(origin);
  expect(rejected.headers.get("vary")).toContain("Origin");
});

it("accepts exactly one authenticated Whiteboard Desktop control stream", async () => {
  const server = await start();
  const controlUrl = new URL("/control", server.discovery.url);
  controlUrl.searchParams.set("token", server.discovery.token);
  const abort = new AbortController();
  const first = await fetch(controlUrl, { signal: abort.signal });

  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe(
    "text/event-stream; charset=utf-8",
  );
  const reader = first.body!.getReader();
  const attached = await reader.read();
  expect(new TextDecoder().decode(attached.value)).toContain(": attached");

  const second = await fetch(controlUrl);
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({
    ok: false,
    error: "A Review Desktop control client is already attached.",
  });

  abort.abort();
  await reader.cancel().catch(() => undefined);
});

it("relays headless Desktop capabilities while its control stream is attached", async () => {
  const server = await start();
  const controlUrl = new URL("/control", server.discovery.url);
  controlUrl.searchParams.set("token", server.discovery.token);
  const abort = new AbortController();
  const control = await fetch(controlUrl, { signal: abort.signal });
  const reader = control.body!.getReader();
  await reader.read();

  const capabilities = server.client.read("/capabilities");
  const event = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Control event timed out.")), 1_000),
    ),
  ]);
  const frame = new TextDecoder().decode(event.value);
  const envelope = JSON.parse(frame.slice("data: ".length)) as {
    id: string;
    request: { name: string };
  };
  expect(envelope.request.name).toBe("authoringCapabilities");

  const result = await fetch(`${server.discovery.url}/control/result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-review-token": server.discovery.token,
    },
    body: JSON.stringify({
      id: envelope.id,
      response: {
        ok: true,
        result: { softwareMapEnabled: true },
      },
    }),
  });
  expect(result.status).toBe(200);
  expect(await capabilities).toMatchObject({
    desktopAvailable: true,
    softwareMapEnabled: true,
  });

  abort.abort();
  await reader.cancel().catch(() => undefined);
  await vi.waitFor(async () => {
    expect(await server.client.read("/capabilities")).toMatchObject({
      desktopAvailable: false,
      softwareMapEnabled: false,
    });
  });
});

it("relays opening an API-only review to the attached Whiteboard Desktop", async () => {
  const server = await start();
  const repo = await repository();
  const registered = await server.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });
  const created = await server.client.post<Result>("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Remote review",
      pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
    },
  });

  const controlUrl = new URL("/control", server.discovery.url);
  controlUrl.searchParams.set("token", server.discovery.token);
  const abort = new AbortController();
  const control = await fetch(controlUrl, { signal: abort.signal });
  const reader = control.body!.getReader();
  await reader.read();

  const opened = server.client.post(`/${created.reviewId}/open`, {});
  const event = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Control event timed out.")), 1_000),
    ),
  ]);
  const frame = new TextDecoder().decode(event.value);
  const envelope = JSON.parse(frame.slice("data: ".length)) as {
    id: string;
    request: {
      name: string;
      args: { reviewId: string; title: string };
    };
  };
  expect(envelope.request).toMatchObject({
    name: "openApiReview",
    args: { reviewId: created.reviewId, title: "Remote review" },
  });

  const result = await fetch(`${server.discovery.url}/control/result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-review-token": server.discovery.token,
    },
    body: JSON.stringify({
      id: envelope.id,
      response: {
        ok: true,
        result: { softwareMapEnabled: true },
      },
    }),
  });
  expect(result.status).toBe(200);
  expect(await opened).toMatchObject({ softwareMapEnabled: true });

  abort.abort();
  await reader.cancel().catch(() => undefined);
});

it("authenticates clients, reports capabilities and readiness without exposing the token, and diagnoses unavailable commits", async () => {
  const server = await start(undefined, true);
  expect(await reviewServerIsHealthy(server.discovery)).toBe(true);
  expect((await fetch(`${server.discovery.url}/reviews-api`)).status).toBe(401);
  expect(await server.client.read("/capabilities")).toMatchObject({
    desktopAvailable: false,
    softwareMapEnabled: true,
  });

  const status = await cli(
    ["--state-dir", server.stateDir, "server", "status", "--json"],
    process.env,
  );

  expect(status).toMatchObject({ exitCode: 0, errors: "" });
  expect(JSON.parse(status.output)).toMatchObject({
    event: "server.status",
    ready: true,
  });
  expect(status.output).not.toContain(server.discovery.token);
  const repo = await repository();

  const registered = await server.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  await expect(
    server.client.post("/pins", {
      repositoryId: registered.id,
      base: "unavailable",
      head: repo.head,
    }),
  ).rejects.toThrow(/Fetch the requested commits/);

  const result = await server.client.post<Result>("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "No UI",
      pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
    },
  });

  await expect(
    server.client.post(`/${result.reviewId}/open`, {}),
  ).rejects.toThrow(/desktop is not connected/);
  await server.stop();
  const stopped = await cli(["server", "status", "--json"], server.env);
  expect(stopped.exitCode).toBe(1);
  expect(JSON.parse(stopped.output)).toMatchObject({ event: "error" });
  await expect(connectReviewApi(server.env)).rejects.toThrow(
    /review server start/,
  );
});

it("rejects a second owner and keeps separate CI job stores independent", async () => {
  const first = await start();
  await expect(
    runHeadlessServer({
      stateDir: first.stateDir,
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow(/already owns/);
  const second = await start(path.join(root, "second"));
  expect(second.discovery.url).not.toBe(first.discovery.url);
  expect(await second.client.read("/capabilities")).toMatchObject({
    softwareMapEnabled: false,
  });
  const repo = await repository();

  const registered = await first.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  await first.client.post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "First job only",
      pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
    },
  });
  expect(await first.client.read("")).toMatchObject([
    { title: "First job only" },
  ]);
  expect(await second.client.read("")).toEqual([]);
  await first.stop();
  expect(await reviewServerIsHealthy(second.discovery)).toBe(true);
});

it("releases ownership after a port bind failure so startup can be retried", async () => {
  const first = await start();
  const stateDir = path.join(root, "retry");
  await expect(
    runHeadlessServer({
      stateDir,
      port: Number(new URL(first.discovery.url).port),
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow(/EADDRINUSE/);
  const retried = await start(stateDir);
  expect(await reviewServerIsHealthy(retried.discovery)).toBe(true);
});

it("does not connect to another instance through stale discovery", async () => {
  const server = await start();
  const discoveryPath = reviewServerDiscoveryPath(server.stateDir);
  const original = JSON.parse(await readFile(discoveryPath, "utf8"));
  await writeFile(
    discoveryPath,
    JSON.stringify({ ...original, instanceId: randomUUID() }),
  );
  await expect(connectReviewApi(server.env)).rejects.toThrow(/not ready/);
});

it("refuses the removed batch authoring mode instead of ignoring it", async () => {
  const result = await cli(
    [
      "--state-dir",
      path.join(root, "refused"),
      "server",
      "start",
      "--authoring-mode",
      "batch",
    ],
    process.env,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.errors).toContain("--authoring-mode was removed");
});
