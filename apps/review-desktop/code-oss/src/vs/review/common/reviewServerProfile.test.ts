/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { parseReviewServerProfiles } from "./reviewServerProfile.js";

test("saved profiles preserve one explicit active selection without accepting secret fields", () => {
	const saved = parseReviewServerProfiles({
		version: 1,
		activeProfileId: "profile-b",
		profiles: [
			{ id: "profile-a", name: "Development", serverUrl: "http://127.0.0.1:5500/", sourceAccessMode: "api-only" },
			{ id: "profile-b", name: "Staging", serverUrl: "https://review.example.test", sourceAccessMode: "api-only" },
		],
	});

	assert.deepEqual(saved, {
		version: 1,
		activeProfileId: "profile-b",
		profiles: [
			{ id: "profile-a", name: "Development", serverUrl: "http://127.0.0.1:5500", sourceAccessMode: "api-only" },
			{ id: "profile-b", name: "Staging", serverUrl: "https://review.example.test", sourceAccessMode: "api-only" },
		],
	});
	assert.throws(() => parseReviewServerProfiles({
		version: 1,
		activeProfileId: "profile-a",
		profiles: [{
			id: "profile-a",
			name: "Development",
			serverUrl: "http://127.0.0.1:5500",
			sourceAccessMode: "api-only",
			token: "must-not-be-settings",
		}],
	}), /invalid/);
});

test("saved profiles reject ambiguous or missing active selections", () => {
	assert.throws(() => parseReviewServerProfiles({
		version: 1,
		activeProfileId: "missing",
		profiles: [{ id: "profile-a", name: "Development", serverUrl: "http://127.0.0.1:5500", sourceAccessMode: "api-only" }],
	}), /active profile/);
	assert.throws(() => parseReviewServerProfiles({
		version: 1,
		activeProfileId: "profile-a",
		profiles: [
			{ id: "profile-a", name: "Development", serverUrl: "http://127.0.0.1:5500", sourceAccessMode: "api-only" },
			{ id: "profile-a", name: "Staging", serverUrl: "http://127.0.0.1:5600", sourceAccessMode: "api-only" },
		],
	}), /unique/);
});

test("the issue 4 single-profile value upgrades to the versioned collection", () => {
	assert.deepEqual(parseReviewServerProfiles({
		id: "legacy-profile",
		name: "Existing server",
		serverUrl: "http://127.0.0.1:5500",
		sourceAccessMode: "api-only",
	}), {
		version: 1,
		activeProfileId: "legacy-profile",
		profiles: [{
			id: "legacy-profile",
			name: "Existing server",
			serverUrl: "http://127.0.0.1:5500",
			sourceAccessMode: "api-only",
		}],
	});
});
