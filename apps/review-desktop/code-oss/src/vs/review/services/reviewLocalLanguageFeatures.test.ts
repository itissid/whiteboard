import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import { apiSourceUri } from "../common/reviewSourceView.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const dom = new JSDOM("<html><body></body></html>");
for (const key of ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "MutationObserver", "Element", "navigator", "customElements", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent"] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as never;
const { ReviewLocalLanguageFeatures } = await import("./reviewLocalLanguageFeatures.js");

const disposable = { dispose() {} };

test("API-only source models never acquire server filesystem language contexts", async (t) => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => {
		requests += 1;
		return Response.json({ rootPath: "/linux-only/repository", identity: "remote" });
	});
	const model = {
		uri: apiSourceUri({
			view: { reviewId: "review-a", version: 1, pins: { repositoryId: "repository", head: "head-sha" } },
			side: "head",
			file: "source.ts",
		}),
		isDisposed: () => false,
	};
	const providers = {
		hoverProvider: { register: () => disposable },
		definitionProvider: { register: () => disposable },
		typeDefinitionProvider: { register: () => disposable },
		implementationProvider: { register: () => disposable },
		referenceProvider: { register: () => disposable },
	};
	const service = new ReviewLocalLanguageFeatures(
		{
			onDidChangeConnection: Event.None,
			getConnection: async () => ({ serverUrl: "http://127.0.0.1:5000", token: "secret", sourceAccessMode: "api-only" }),
		} as never,
		{} as never,
		{ onModelAdded: Event.None, getModels: () => [model] } as never,
		providers as never,
		{} as never,
		{} as never,
		{} as never,
		{ onDidFilesChange: Event.None } as never,
		{ debug() {} } as never,
	);
	t.after(() => service.dispose());
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(requests, 0);
});
