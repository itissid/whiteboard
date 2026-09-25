import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import { basename } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import { EditorInputCapabilities } from "../../workbench/common/editor.js";
import { ReviewSourceEditorInput } from "./reviewSourceEditorInput.js";

function createInput() {
	const resource = URI.parse("review-api-source://review-a/src/example.ts?version=3&side=head");
	return new ReviewSourceEditorInput(
		resource,
		undefined,
		undefined,
		undefined,
		undefined,
		{} as never,
		{} as never,
		{} as never,
		{
			onDidChangeFileSystemProviderRegistrations: Event.None,
			onDidChangeFileSystemProviderCapabilities: Event.None,
			hasProvider: () => false,
		} as never,
		{
			onDidChangeFormatters: Event.None,
			getUriBasenameLabel: (uri: URI) => basename(uri),
			getUriLabel: (uri: URI) => uri.path,
		} as never,
		{ onDidChangeReadonly: Event.None, isReadonly: () => false } as never,
		{} as never,
		{ onDidChange: Event.None, getName: () => undefined } as never,
	);
}

test("API Source Editors expose an immutable full-file tab with the source title", async (t) => {
	const input = createInput();
	t.after(() => input.dispose());
	assert.equal(input.getName(), "example.ts");
	assert.equal(input.isReadonly(), true);
	assert.equal(input.hasCapability(EditorInputCapabilities.Readonly), true);
	assert.equal(input.hasCapability(EditorInputCapabilities.CanSplitInGroup), true);
	assert.equal(await input.save(), undefined);
	assert.equal(await input.saveAs(), undefined);
});
