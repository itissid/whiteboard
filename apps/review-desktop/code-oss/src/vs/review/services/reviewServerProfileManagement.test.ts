/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { REVIEW_DESKTOP_CONNECTION_VERSION } from "../common/reviewDesktopBootstrap.js";
import {
	REVIEW_SERVER_PROFILE_SETTING,
	reviewServerProfileTokenKey,
	type ReviewServerConnectionProfiles,
} from "../common/reviewServerProfile.js";
import { ReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

class TestStorage {
	getBoolean(_key: string, _scope: unknown, fallback: boolean): boolean { return fallback; }
	store(): void {}
	remove(): void {}
}

function mockFetch(t: { after(callback: () => void): void }, handler: typeof fetch): void {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	t.after(() => { globalThis.fetch = original; });
}

function setup() {
	const settings = new Map<string, unknown>();
	const secrets = new Map<string, string>();
	const commands: string[] = [];
	const embedded = {
		version: REVIEW_DESKTOP_CONNECTION_VERSION,
		url: "http://127.0.0.1:5000",
		token: "embedded-token",
		instanceId: "embedded-instance",
		appSessionId: "app-session",
		sourceAccessMode: "shared-filesystem",
	} as const;
	const mainProcessService = {
		getChannel() {
			return {
				call(command: string) {
					commands.push(command);
					if (command === "getAppSessionId") return Promise.resolve("app-session");
					if (command === "getConnection") return Promise.resolve(embedded);
					return Promise.resolve(undefined);
				},
			};
		},
	};
	const configurationService = {
		getValue(key: string) { return settings.get(key); },
		updateValue(key: string, value: unknown) {
			settings.set(key, value);
			return Promise.resolve();
		},
	};
	const secretStorageService = {
		get(key: string) { return Promise.resolve(secrets.get(key)); },
		set(key: string, value: string) { secrets.set(key, value); return Promise.resolve(); },
		delete(key: string) { secrets.delete(key); return Promise.resolve(); },
	};
	const createService = () => new ReviewDesktopConnectionService(
		mainProcessService as never,
		new TestStorage() as never,
		configurationService as never,
		secretStorageService as never,
	);
	return { commands, createService, embedded, secrets, settings };
}

const compatibleResponse = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const url = String(input);
	const token = new Headers(init?.headers).get("x-review-token");
	if (url.endsWith("/health")) {
		return Promise.resolve(Response.json({
			ok: true,
			instanceId: url.startsWith("http://127.0.0.1:5000") ? "embedded-instance" : `instance-${token}`,
		}));
	}
	return Promise.resolve(Response.json({ desktopAvailable: false, softwareMapEnabled: false, scratchpadEnabled: false }));
};

test("multiple profiles keep stable identifiers while metadata and profile-specific secrets round-trip separately", async (t) => {
	const { createService, secrets, settings } = setup();
	mockFetch(t, compatibleResponse);
	const service = createService();
	t.after(() => service.dispose());

	await service.createAndActivateRemoteProfile({
		name: "Development",
		serverUrl: "http://127.0.0.1:5500",
		token: "development-token",
		externalSourceOpener: {
			executable: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
			authority: "development-host",
		},
	});
	const first = service.getRemoteProfiles().profiles[0]!;
	await service.createAndActivateRemoteProfile({ name: "Staging", serverUrl: "https://review.example.test", token: "staging-token" });
	const created = service.getRemoteProfiles();
	assert.equal(created.profiles.length, 2);
	assert.equal(created.activeProfileId, created.profiles[1]!.id);
	assert.equal(JSON.stringify(settings.get(REVIEW_SERVER_PROFILE_SETTING)).includes("token"), false);
	assert.equal(secrets.get(reviewServerProfileTokenKey(first.id)), "development-token");
	assert.equal(secrets.get(reviewServerProfileTokenKey(created.profiles[1]!.id)), "staging-token");

	await service.editRemoteProfile(first.id, {
		name: "Development renamed",
		serverUrl: "http://127.0.0.1:5700",
	});
	const edited = service.getRemoteProfiles();
	assert.equal(edited.profiles[0]!.id, first.id);
	assert.equal(edited.profiles[0]!.name, "Development renamed");
	assert.deepEqual(edited.profiles[0]!.externalSourceOpener, first.externalSourceOpener);
	assert.equal(secrets.get(reviewServerProfileTokenKey(first.id)), "development-token");
	assert.equal(edited.activeProfileId, created.profiles[1]!.id);

	await service.removeRemoteProfile(first.id);
	assert.deepEqual(service.getRemoteProfiles().profiles.map(profile => profile.name), ["Staging"]);
	assert.equal(secrets.has(reviewServerProfileTokenKey(first.id)), false);
	assert.equal((settings.get(REVIEW_SERVER_PROFILE_SETTING) as ReviewServerConnectionProfiles).version, 1);
});

test("an explicit switch persists exactly one active profile across service lifecycles", async (t) => {
	const { createService } = setup();
	mockFetch(t, compatibleResponse);
	const service = createService();
	await service.createAndActivateRemoteProfile({ name: "Development", serverUrl: "http://127.0.0.1:5500", token: "development-token" });
	const development = service.getRemoteProfiles().profiles[0]!;
	await service.createAndActivateRemoteProfile({ name: "Staging", serverUrl: "http://127.0.0.1:5600", token: "staging-token" });

	const switched = await service.switchRemoteProfile(development.id);
	assert.equal(switched.status, "connected");
	assert.equal(service.getRemoteProfiles().activeProfileId, development.id);
	service.dispose();

	const restarted = createService();
	t.after(() => restarted.dispose());
	assert.equal((await restarted.getConnection()).serverUrl, "http://127.0.0.1:5500");
	assert.equal(restarted.getRemoteProfiles().activeProfileId, development.id);
});

test("rejected and unreachable selections remain authoritative until retry or an explicit switch", async (t) => {
	const { commands, createService } = setup();
	let rejected = true;
	mockFetch(t, async (input, init) => {
		const token = new Headers(init?.headers).get("x-review-token");
		if (token === "rejected-token" && rejected) return Response.json({ error: "Unauthorized" }, { status: 401 });
		if (token === "unreachable-token") throw new TypeError("connect refused");
		return compatibleResponse(input, init);
	});
	const service = createService();
	t.after(() => service.dispose());
	await service.createAndActivateRemoteProfile({ name: "Development", serverUrl: "http://127.0.0.1:5500", token: "development-token" });
	const development = service.getRemoteProfiles().profiles[0]!;

	const rejectedState = await service.createAndActivateRemoteProfile({ name: "Rejected", serverUrl: "http://127.0.0.1:5600", token: "rejected-token" });
	assert.equal(rejectedState.status, "disconnected");
	assert.equal(rejectedState.status === "disconnected" && rejectedState.reason, "rejected-token");
	const rejectedProfile = service.getRemoteProfiles().profiles[1]!;
	assert.equal(service.getRemoteProfiles().activeProfileId, rejectedProfile.id);
	await assert.rejects(service.getConnection(), /rejected the token/);
	assert.equal(commands.includes("getConnection"), false);

	rejected = false;
	const recovered = await service.retryRemoteProfile();
	assert.equal(recovered.status, "connected");
	assert.equal((await service.getConnection()).serverUrl, "http://127.0.0.1:5600");
	assert.equal(service.getRemoteProfiles().activeProfileId, rejectedProfile.id);

	const unreachableState = await service.createAndActivateRemoteProfile({ name: "Unavailable", serverUrl: "http://127.0.0.1:5700", token: "unreachable-token" });
	assert.equal(unreachableState.status, "disconnected");
	assert.equal(unreachableState.status === "disconnected" && unreachableState.reason, "unreachable");
	assert.equal(service.getRemoteProfiles().activeProfileId, service.getRemoteProfiles().profiles[2]!.id);
	await service.switchRemoteProfile(development.id);
	assert.equal((await service.getConnection()).serverUrl, development.serverUrl);
});

test("a connected remote profile becomes deliberately disconnected when its live control channel rejects credentials", async (t) => {
	const { createService } = setup();
	let controlRequests = 0;
	mockFetch(t, async (input, init) => {
		if (String(input).includes("/control")) {
			controlRequests += 1;
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}
		return compatibleResponse(input, init);
	});
	const service = createService();
	t.after(() => service.dispose());
	await service.createAndActivateRemoteProfile({ name: "Development", serverUrl: "http://127.0.0.1:5500", token: "development-token" });
	const disconnected = new Promise<ReturnType<typeof service.getConnectionState>>(resolve => {
		const listener = service.onDidChangeConnectionState(state => {
			if (state.status !== "disconnected") return;
			listener.dispose();
			resolve(state);
		});
	});

	service.attachControl(async () => ({ ok: true }));
	const state = await disconnected;

	assert.equal(state.status, "disconnected");
	assert.equal(state.status === "disconnected" && state.reason, "rejected-token");
	assert.equal(controlRequests, 1);
	await assert.rejects(service.getConnection(), /rejected the token/);
});

test("removing the only active profile deliberately returns to the embedded server", async (t) => {
	const { commands, createService, embedded, secrets, settings } = setup();
	mockFetch(t, compatibleResponse);
	const service = createService();
	t.after(() => service.dispose());
	await service.createAndActivateRemoteProfile({ name: "Development", serverUrl: "http://127.0.0.1:5500", token: "development-token" });
	const profile = service.getRemoteProfiles().profiles[0]!;

	const state = await service.removeRemoteProfile(profile.id);
	assert.equal(state.status, "connected");
	assert.equal(settings.get(REVIEW_SERVER_PROFILE_SETTING), null);
	assert.equal(secrets.has(reviewServerProfileTokenKey(profile.id)), false);
	assert.deepEqual(await service.getConnection(), {
		serverUrl: embedded.url,
		token: embedded.token,
		appSessionId: embedded.appSessionId,
		sourceAccessMode: embedded.sourceAccessMode,
	});
	assert.deepEqual(commands.slice(-2), ["activateEmbeddedConnection", "getConnection"]);
});

test("an active profile cannot be removed while another saved profile would become an implicit fallback", async (t) => {
	const { createService } = setup();
	mockFetch(t, compatibleResponse);
	const service = createService();
	t.after(() => service.dispose());
	await service.createAndActivateRemoteProfile({ name: "Development", serverUrl: "http://127.0.0.1:5500", token: "development-token" });
	await service.createAndActivateRemoteProfile({ name: "Staging", serverUrl: "http://127.0.0.1:5600", token: "staging-token" });
	const active = service.getRemoteProfiles().profiles[1]!;

	await assert.rejects(service.removeRemoteProfile(active.id), /Switch to another profile/);
	assert.equal(service.getRemoteProfiles().activeProfileId, active.id);
});
