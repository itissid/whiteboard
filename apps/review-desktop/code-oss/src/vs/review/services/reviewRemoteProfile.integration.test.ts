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

import { Event } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
import type { ITextModelContentProvider } from "../../editor/common/services/resolverService.js";
import type { IOpenWindowOptions, IWindowOpenable } from "../../platform/window/common/window.js";
import { REVIEW_SERVER_PROFILE_SETTING, reviewServerProfileTokenKey } from "../common/reviewServerProfile.js";
import { apiSourceUri, sourceLocation, sourceTreeUri } from "../common/reviewSourceView.js";
import { ReviewCanvasEditorInput } from "../browser/parts/canvas/reviewCanvasEditorInput.js";
import { ReviewApiClient } from "../common/reviewProtocol.js";
import { ReviewApiCatalogService } from "./reviewApiCatalogService.js";
import { ReviewApiSourceService } from "./reviewApiSourceService.js";
import { ReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";
import { ReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";
import { openActiveReviewSourceInVsCode } from "./reviewExternalSourceOpenerService.js";

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
	await writeFile(path.join(directory, "old-name.ts"), "export const renamed = true;\n");
	await writeFile(path.join(directory, "deleted.ts"), "export const removed = true;\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	await mkdir(path.join(directory, "nested"));
	await writeFile(path.join(directory, "example.ts"), "export const value = 2;\n");
	await writeFile(path.join(directory, "added.md"), "# Added\n");
	await writeFile(path.join(directory, "nested", "neighbor.ts"), "export const neighbor = 3;\n");
	git("mv", "old-name.ts", "renamed.ts");
	git("rm", "-q", "deleted.ts");
	git("add", ".");
	git("commit", "-qm", "head");
	return { directory, base, head: git("rev-parse", "HEAD") };
}

test("a saved API-only profile retries real authentication without embedded fallback before review and authoring flows", async (t) => {
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
	let savedToken = "rejected-token";
	const service = new ReviewDesktopConnectionService(
		mainProcessService as never,
		new TestStorage() as never,
		{
			getValue: (key: string) => key === REVIEW_SERVER_PROFILE_SETTING
				? { version: 1, activeProfileId: profile.id, profiles: [profile] }
				: undefined,
		} as never,
		{ get: (key: string) => Promise.resolve(key === reviewServerProfileTokenKey(profile.id) ? savedToken : undefined) } as never,
	);
	t.after(() => service.dispose());

	await assert.rejects(service.getConnection(), /rejected the token/);
	const disconnected = service.getConnectionState();
	assert.equal(disconnected.status, "disconnected");
	assert.equal(disconnected.status === "disconnected" && disconnected.reason, "rejected-token");
	assert.equal(embeddedRequests, 0);
	savedToken = discovery.token;
	assert.equal((await service.retryRemoteProfile()).status, "connected");
	const connection = await service.getConnection();
	assert.equal(connection.serverUrl, discovery.url);
	assert.equal(connection.sourceAccessMode, "api-only");
	assert.equal(remoteActivations, 2);
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

test("real headless source references use API editors or Native Source Workspaces by capability", async (t) => {
	const headlessHostUrl = new URL("../../../../../../../packages/review/src/server/headless-host.ts", import.meta.url).href;
	const { runHeadlessServer } = await import(headlessHostUrl) as {
		runHeadlessServer(input: {
			stateDir: string;
			signal: AbortSignal;
			onReady(discovery: { instanceId: string; url: string; token: string }): void;
		}): Promise<void>;
	};
	const root = await mkdtemp(path.join(tmpdir(), "whiteboard-api-source-editor-"));
	const controller = new AbortController();
	const ready = Promise.withResolvers<{ instanceId: string; url: string; token: string }>();
	const running = runHeadlessServer({ stateDir: path.join(root, "state"), signal: controller.signal, onReady: ready.resolve });
	t.after(async () => {
		controller.abort();
		await running;
		await rm(root, { recursive: true, force: true });
	});
	const discovery = await ready.promise;
	const repository = await createRepository(root);
	const connection = { serverUrl: discovery.url, token: discovery.token, appSessionId: "source-integration", sourceAccessMode: "api-only" } as const;
	const client = new ReviewApiClient(connection);
	const registered = await client.post<{ id: string }>("/repositories", { path: repository.directory });
	const created = await client.post<{ reviewId: string }>("/commands", {
		commandId: randomUUID(),
		operation: {
			type: "create",
			title: "Source route integration",
			pins: { repositoryId: registered.id, base: repository.base, head: repository.head },
		},
	});
	const target = {
		view: { reviewId: created.reviewId, version: 0 },
		side: "head" as const,
		file: "example.ts",
	};
	const resource = apiSourceUri(target);
	const requests: URL[] = [];
	const realFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new URL(typeof input === "string" || input instanceof URL ? input : input.url));
		return realFetch(input, init);
	});
	const apiWindows: Array<{ openables: IWindowOpenable[]; options: IOpenWindowOptions }> = [];
	const canvasInputs: ReviewCanvasEditorInput[] = [];
	const sourceTabs: ReviewCanvasEditorInput[] = [];
	const apiTabs = new ReviewCanvasEditorTabsService(
		{
			createInstance(_ctor: unknown, canvasTarget: ConstructorParameters<typeof ReviewCanvasEditorInput>[0]) {
				const input = new ReviewCanvasEditorInput(canvasTarget, {} as never);
				canvasInputs.push(input);
				return input;
			},
		} as never,
		{
			onDidCloseEditor: Event.None,
			async openEditor(input: ReviewCanvasEditorInput) { sourceTabs.push(input); },
		} as never,
		{ groups: [], mainPart: { activeGroup: {} } } as never,
		{ getConnection: async () => connection } as never,
		{ openWindow: async (openables: IWindowOpenable[], options: IOpenWindowOptions) => { apiWindows.push({ openables, options }); } } as never,
		{ warn() {} } as never,
	);
	t.after(() => {
		apiTabs.dispose();
		canvasInputs.forEach(input => input.dispose());
	});
	const sourceSelection = { reviewId: created.reviewId, kind: "version" as const, version: 0 };
	await apiTabs.openApiSource(sourceSelection, "Source route integration");
	assert.equal(sourceTabs[0]!.getName(), "Source — Source route integration (v0)");
	assert.deepEqual(sourceTabs[0]!.target, { kind: "api-source", reviewId: created.reviewId, selection: sourceSelection, title: "Source route integration" });
	assert.equal(await apiTabs.openSourceEditor({ resource }), false);
	assert.equal(apiWindows.length, 0);
	assert.equal(requests.some(request => request.pathname.endsWith("/navigator")), false);

	let provider: ITextModelContentProvider | undefined;
	const openedSources: Array<{ resource: URI; options?: { selection?: unknown } }> = [];
	const openedDiffs: Array<{ original: { resource: URI }; modified: { resource: URI } }> = [];
	const models = new Map<string, { uri: URI; text: string; languageId: string; getLineCount(): number }>();
	const apiSources = new ReviewApiSourceService(
		{ getConnection: async () => connection } as never,
		{
			registerTextModelContentProvider(scheme: string, candidate: ITextModelContentProvider) {
				if (scheme === "review-api-source") provider = candidate;
				return { dispose() {} };
			},
		} as never,
		{
			getModel: (uri: URI) => models.get(uri.toString()),
			createModel: (text: string, language: { languageId: string }, uri: URI) => {
				const model = { uri, text, languageId: language.languageId, getLineCount: () => text.split("\n").length };
				models.set(uri.toString(), model);
				return model;
			},
		} as never,
		{ createByFilepathOrFirstLine: (uri: URI) => ({ languageId: uri.path.endsWith(".ts") ? "typescript" : uri.path.endsWith(".md") ? "markdown" : "plaintext" }) } as never,
		{
			openEditor: async (input: { resource: URI; options?: { selection?: unknown } } | { original: { resource: URI }; modified: { resource: URI } }) => {
				if ("resource" in input) openedSources.push(input);
				else openedDiffs.push(input);
				return { input: { resource: "resource" in input ? input.resource : input.modified.resource } };
			},
		} as never,
		apiTabs,
		{ watch() { throw new Error("API-only source attempted to watch a server path"); }, onDidFilesChange: Event.None } as never,
	);
	t.after(() => apiSources.dispose());
	await apiSources.open(target, { startLine: 1, startColumn: 8, endLine: 1, endColumn: 13 });
	assert.equal(openedSources[0]!.resource.toString(), resource.toString());
	assert.deepEqual(openedSources[0]!.options?.selection, { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 13 });
	const model = await provider!.provideTextContent(openedSources[0]!.resource) as unknown as { text: string; languageId: string };
	assert.equal(model.text, "export const value = 2;\n");
	assert.equal(model.languageId, "typescript");
	const fileRequest = requests.find(request => request.pathname.endsWith(`/${created.reviewId}/file`));
	assert.equal(fileRequest?.searchParams.get("version"), "0");
	assert.equal(fileRequest?.searchParams.has("commit"), false);
	assert.equal(fileRequest?.searchParams.get("side"), "head");
	assert.equal(fileRequest?.searchParams.get("file"), "example.ts");

	const rootEntries = await apiSources.children(sourceTreeUri(sourceSelection));
	assert.deepEqual(rootEntries.map(entry => [entry.name, entry.isDirectory]), [
		["added.md", false],
		["example.ts", false],
		["nested", true],
		["renamed.ts", false],
	]);
	const nested = rootEntries.find(entry => entry.name === "nested")!;
	const [neighbor] = await apiSources.children(nested.resource);
	assert.equal(neighbor!.resource.scheme, "review-api-source");
	assert.equal(new URLSearchParams(neighbor!.resource.query).get("version"), "0");
	await apiSources.open(sourceLocation(neighbor!.resource));
	const neighborModel = await provider!.provideTextContent(neighbor!.resource) as unknown as { text: string; languageId: string };
	assert.equal(neighborModel.text, "export const neighbor = 3;\n");
	assert.equal(neighborModel.languageId, "typescript");
	assert.notEqual(openedSources.at(-1)!.resource.toString(), openedSources[0]!.resource.toString());

	for (const file of ["example.ts", "renamed.ts", "added.md", "deleted.ts"]) {
		await apiSources.openDiff(target.view, file);
	}
	assert.equal(openedDiffs[0]!.original.resource.path, "/example.ts");
	assert.equal(openedDiffs[0]!.modified.resource.path, "/example.ts");
	assert.equal(openedDiffs[1]!.original.resource.path, "/old-name.ts");
	assert.equal(openedDiffs[1]!.modified.resource.path, "/renamed.ts");
	assert.equal(new URLSearchParams(openedDiffs[2]!.original.resource.query).get("empty"), "true");
	assert.equal(new URLSearchParams(openedDiffs[3]!.modified.resource.query).get("empty"), "true");
	for (const input of openedDiffs) {
		for (const side of [input.original.resource, input.modified.resource]) {
			assert.equal(side.scheme, "review-api-source");
			assert.equal(new URLSearchParams(side.query).get("version"), "0");
		}
	}
	const baseModel = await provider!.provideTextContent(openedDiffs[0]!.original.resource) as unknown as { text: string; languageId: string };
	const headModel = await provider!.provideTextContent(openedDiffs[0]!.modified.resource) as unknown as { text: string; languageId: string };
	assert.deepEqual([baseModel.text, headModel.text], ["export const value = 1;\n", "export const value = 2;\n"]);
	assert.deepEqual([baseModel.languageId, headModel.languageId], ["typescript", "typescript"]);
	const addedBase = await provider!.provideTextContent(openedDiffs[2]!.original.resource) as unknown as { text: string };
	const addedHead = await provider!.provideTextContent(openedDiffs[2]!.modified.resource) as unknown as { text: string; languageId: string };
	assert.equal(addedBase.text, "");
	assert.deepEqual([addedHead.text, addedHead.languageId], ["# Added\n", "markdown"]);
	const deletedBase = await provider!.provideTextContent(openedDiffs[3]!.original.resource) as unknown as { text: string };
	const deletedHead = await provider!.provideTextContent(openedDiffs[3]!.modified.resource) as unknown as { text: string };
	assert.equal(deletedBase.text, "export const removed = true;\n");
	assert.equal(deletedHead.text, "");
	await assert.rejects(apiSources.openDiff(target.view, "unchanged.ts"), /not changed/);
	await assert.rejects(
		async () => provider!.provideTextContent(apiSourceUri({ ...target, file: "missing.ts" })),
		/unavailable at the pinned commit/,
	);
	await assert.rejects(
		apiSources.children(sourceTreeUri({ reviewId: created.reviewId, kind: "version", version: 999 })),
		/Review or version not found/,
	);

	const sharedCreated = await client.post<{ reviewId: string }>("/commands", {
		commandId: randomUUID(),
		operation: {
			type: "create",
			title: "Shared source route integration",
			target: { kind: "worktree", repositoryId: registered.id, base: repository.base },
		},
	});
	const sharedSelection = { reviewId: sharedCreated.reviewId, kind: "version" as const, version: 0 };
	const sharedView = { reviewId: sharedCreated.reviewId, version: 0 };
	const sharedResource = apiSourceUri({ view: sharedView, side: "head", file: "example.ts" });
	await apiSources.openDiff(sharedView, "renamed.ts");
	const sharedDiff = openedDiffs.at(-1)!;

	const handoffs: unknown[] = [];
	assert.deepEqual(await openActiveReviewSourceInVsCode({
		connection,
		profile: {
			id: "remote-profile",
			name: "Headless integration server",
			serverUrl: discovery.url,
			sourceAccessMode: "api-only",
			externalSourceOpener: {
				executable: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
				authority: "development-host",
			},
		},
		editor: {
			getModel: () => ({ uri: resource }),
			getSelection: () => ({ getStartPosition: () => ({ lineNumber: 1, column: 8 }) }),
			getPosition: () => null,
		},
		processAdapter: {
			open: async request => {
				handoffs.push(request);
				return { status: "accepted" };
			},
		},
	}), { status: "accepted" });
	assert.equal(handoffs.length, 1);
	const handoff = handoffs[0] as { executable: string; authority: string; filePath: string; lineNumber: number; column: number };
	assert.equal(handoff.executable, "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
	assert.equal(handoff.authority, "development-host");
	assert.equal(path.isAbsolute(handoff.filePath), true);
	assert.equal(handoff.filePath.endsWith("/example.ts"), true);
	assert.equal(handoff.lineNumber, 1);
	assert.equal(handoff.column, 8);
	const navigatorRequest = requests.find(request => request.pathname.endsWith(`/${created.reviewId}/navigator`));
	assert.equal(navigatorRequest?.searchParams.get("version"), "0");
	assert.equal(navigatorRequest?.searchParams.get("side"), "head");
	assert.equal(navigatorRequest?.searchParams.get("file"), "example.ts");
	assert.equal(navigatorRequest?.searchParams.get("external"), "true");

	requests.length = 0;
	const sharedWindows: Array<{ openables: IWindowOpenable[]; options: IOpenWindowOptions }> = [];
	const sharedTabs = new ReviewCanvasEditorTabsService(
		{} as never,
		{ onDidCloseEditor: Event.None } as never,
		{} as never,
		{ getConnection: async () => ({ ...connection, sourceAccessMode: "shared-filesystem" }) } as never,
		{ openWindow: async (openables: IWindowOpenable[], options: IOpenWindowOptions) => { sharedWindows.push({ openables, options }); } } as never,
		{ warn() {} } as never,
	);
	t.after(() => sharedTabs.dispose());
	await sharedTabs.openApiSource(sharedSelection, "Shared source route integration");
	assert.equal(sharedWindows.length, 1);
	assert.deepEqual(sharedWindows[0]!.options, { forceNewWindow: true });
	assert.equal(await sharedTabs.openSourceEditor({ resource: sharedResource }), true);
	assert.equal(sharedWindows.length, 2);
	const [workspace, file] = sharedWindows[1]!.openables;
	assert.ok(workspace && "workspaceUri" in workspace);
	assert.ok(file && "fileUri" in file);
	assert.equal(workspace.workspaceUri.scheme, "file");
	assert.equal(file.fileUri.scheme, "file");
	assert.deepEqual(sharedWindows[1]!.options, { forceNewWindow: true, gotoLineMode: true, diffMode: false });
	await assert.rejects(
		sharedTabs.openSourceEditor(sharedDiff),
		/Open this review in Desktop to prepare language workspaces/,
	);
	assert.equal(sharedWindows.length, 2);
	assert.equal(requests.filter(request => request.pathname.endsWith(`/${sharedCreated.reviewId}/navigator`)).length, 4);
});
