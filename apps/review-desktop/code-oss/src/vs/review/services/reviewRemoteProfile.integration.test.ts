/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { REVIEW_SERVER_PROFILE_SETTING, reviewServerProfileTokenKey } from "../common/reviewServerProfile.js";
import { ReviewApiClient } from "../common/reviewProtocol.js";
import { ReviewApiCatalogService } from "./reviewApiCatalogService.js";
import { ReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

class TestStorage {
	getBoolean(_key: string, _scope: unknown, fallback: boolean): boolean { return fallback; }
	store(): void {}
	remove(): void {}
}

async function createRepository(root: string) {
	const directory = path.join(root, "repo");
	await mkdir(directory);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Whiteboard Test");
	git("config", "user.email", "whiteboard-test@example.invalid");
	await writeFile(path.join(directory, "example.ts"), "export const value = 1;\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	await writeFile(path.join(directory, "example.ts"), "export const value = 2;\n");
	git("commit", "-qam", "head");
	return { directory, base, head: git("rev-parse", "HEAD") };
}

test("a saved API-only profile uses a real headless server for review and authoring flows", async (t) => {
	// Runtime-only import keeps the Code OSS compiler rooted in its own tree while
	// this integration test exercises the workspace's real headless host.
	const headlessHostUrl = new URL("../../../../../../../packages/review/src/server/headless-host.ts", import.meta.url).href;
	const { runHeadlessServer } = await import(headlessHostUrl) as {
		runHeadlessServer(input: {
			stateDir: string;
			signal: AbortSignal;
			onReady(discovery: { instanceId: string; url: string; token: string }): void;
		}): Promise<void>;
	};
	const root = await mkdtemp(path.join(tmpdir(), "whiteboard-remote-profile-"));
	const controller = new AbortController();
	const ready = Promise.withResolvers<{ instanceId: string; url: string; token: string }>();
	const running = runHeadlessServer({
		stateDir: path.join(root, "state"),
		signal: controller.signal,
		onReady: ready.resolve,
	});
	t.after(async () => {
		controller.abort();
		await running;
		await rm(root, { recursive: true, force: true });
	});
	const discovery = await ready.promise;
	const profile = {
		id: "remote-profile",
		name: "Headless integration server",
		serverUrl: discovery.url,
		sourceAccessMode: "api-only",
	} as const;
	let embeddedRequests = 0;
	let remoteActivations = 0;
	const mainProcessService = {
		getChannel() {
			return {
				call(command: string) {
					if (command === "getAppSessionId") return Promise.resolve("integration-app-session");
					if (command === "activateRemoteProfile") {
						remoteActivations += 1;
						return Promise.resolve();
					}
					embeddedRequests += 1;
					throw new Error(`Unexpected embedded command: ${command}`);
				},
			};
		},
	};
	const service = new ReviewDesktopConnectionService(
		mainProcessService as never,
		new TestStorage() as never,
		{ getValue: (key: string) => key === REVIEW_SERVER_PROFILE_SETTING ? profile : undefined } as never,
		{ get: (key: string) => Promise.resolve(key === reviewServerProfileTokenKey(profile.id) ? discovery.token : undefined) } as never,
	);
	t.after(() => service.dispose());

	const connection = await service.getConnection();
	assert.equal(connection.serverUrl, discovery.url);
	assert.equal(connection.sourceAccessMode, "api-only");
	assert.equal(remoteActivations, 1);
	assert.equal(embeddedRequests, 0);

	const repository = await createRepository(root);
	const client = new ReviewApiClient(connection);
	const registered = await client.post<{ id: string }>("/repositories", { path: repository.directory });
	const created = await client.post<{ reviewId: string }>("/commands", {
		commandId: randomUUID(),
		operation: {
			type: "create",
			title: "Remote review",
			pins: { repositoryId: registered.id, base: repository.base, head: repository.head },
		},
	});
	const catalog = new ReviewApiCatalogService(
		service,
		{ warn() {} } as never,
		{ getValue: () => true, onDidChangeConfiguration: () => ({ dispose() {} }) } as never,
	);
	t.after(() => catalog.dispose());
	await catalog.initialize();
	assert.deepEqual(catalog.reviews.map(({ reviewId, title }) => ({ reviewId, title })), [
		{ reviewId: created.reviewId, title: "Remote review" },
	]);
	assert.equal((await client.read<{ title: string }>(`/${created.reviewId}?full=true`)).title, "Remote review");
	const abort = new AbortController();
	t.after(() => abort.abort());
	const updates = client.watch(created.reviewId, abort.signal);
	await updates.next();
	await client.post("/commands", {
		commandId: randomUUID(),
		operation: {
			type: "edit",
			reviewId: created.reviewId,
			edit: { type: "insert", content: { type: "markdown", markdown: "Authored remotely" } },
		},
	});
	let authored: unknown;
	for await (const update of updates) {
		if (typeof update === "object" && update !== null && !Array.isArray(update) && "version" in update && update.version === 1) {
			authored = update;
			break;
		}
	}
	assert.deepEqual((authored as { document: Array<{ type: string; markdown: string }> }).document
		.map(({ type, markdown }) => ({ type, markdown })), [{ type: "markdown", markdown: "Authored remotely" }]);
	assert.equal((await client.read<{ text: string }>(`/${created.reviewId}/file?side=head&file=example.ts`)).text, "export const value = 2;\n");
});
