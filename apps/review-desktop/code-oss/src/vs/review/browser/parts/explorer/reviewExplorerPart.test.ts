/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";

import { URI } from "../../../../base/common/uri.js";

// jsdom ships no types here; the DOM globals below are all this test reads from it.
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const dom = new JSDOM("<html><body></body></html>");
for (const key of ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "MutationObserver", "Element", "navigator", "customElements", "UIEvent", "MouseEvent", "KeyboardEvent"] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } }) as never;
registerHooks({
	load(url, context, next) {
		return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
	},
});
const { ReviewExplorerDataSource } = await import("./reviewExplorerPart.js");

test("source tree reports pinned source failures instead of silently appearing empty", async () => {
	const sourceError = new Error("Review or version not found.");
	const notifications: unknown[] = [];
	const source = new ReviewExplorerDataSource(
		{ matches: () => false } as never,
		{ trace() {} } as never,
		{ children: async () => { throw sourceError; } } as never,
		{ error: (error: unknown) => notifications.push(error) } as never,
	);

	assert.deepEqual(await source.getChildren(URI.parse("review-api-tree://review-a/?version=999")), []);
	assert.deepEqual(notifications, [sourceError]);
});
