/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewTelemetryService } from "./reviewTelemetryService.js";

test("telemetry follows the active Desktop connection instead of requesting an embedded server", async (t) => {
	const requests: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		requests.push(String(input));
		return Response.json({ ok: true });
	};
	t.after(() => { globalThis.fetch = originalFetch; });
	const service = new ReviewTelemetryService(
		{
			getConnection: () => Promise.resolve({
				serverUrl: "http://127.0.0.1:5500",
				token: "remote-token",
				appSessionId: "app-session",
				sourceAccessMode: "api-only",
			}),
		} as never,
		{ getValue: () => true } as never,
		{ onWillShutdown: () => ({ dispose() {} }) } as never,
	);

	service.capture("remote_profile_connected");
	await service.flush();

	assert.deepEqual(requests, ["http://127.0.0.1:5500/telemetry/event"]);
});
