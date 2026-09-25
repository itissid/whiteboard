/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { REVIEW_DESKTOP_CONNECTION_VERSION } from "../common/reviewDesktopBootstrap.js";
import { REVIEW_SERVER_PROFILE_SETTING, reviewServerProfileTokenKey } from "../common/reviewServerProfile.js";
import { ReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

const uuid = "11111111-1111-4111-8111-111111111111";
class TestStorage {
	private readonly values = new Map<string, boolean>();

	getBoolean(key: string, _scope: unknown, fallback: boolean): boolean {
		return this.values.get(key) ?? fallback;
	}

	store(key: string, value: boolean): void {
		this.values.set(key, value);
	}

	remove(key: string): void {
		this.values.delete(key);
	}
}

const noProfileConfiguration = { getValue: () => undefined };
const noSecrets = { get: () => Promise.resolve(undefined) };

function serviceWith(storage = new TestStorage()): ReviewDesktopConnectionService {
	const service = new ReviewDesktopConnectionService(
		{} as never,
		storage as never,
		noProfileConfiguration as never,
		noSecrets as never,
	);
	Object.assign(service, {
		connection: {
			version: 1,
			url: "http://127.0.0.1:5000",
			token: "token",
			instanceId: "instance",
		},
		initializePromise: Promise.resolve(),
	});
	return service;
}

function mockFetch(t: { after(callback: () => void): void }, handler: typeof fetch): void {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	t.after(() => {
		globalThis.fetch = original;
	});
}

test("exposes the main process Source Access Mode without inferring it from a loopback URL", async (t) => {
	const desktopConnection = {
		version: REVIEW_DESKTOP_CONNECTION_VERSION,
		url: "http://127.0.0.1:5000",
		token: "token",
		instanceId: "instance",
		appSessionId: "app-session",
		sourceAccessMode: "api-only",
	} as const;
	const mainProcessService = {
		getChannel() {
			return { call: () => Promise.resolve(desktopConnection) };
		},
	};
	mockFetch(t, async (input) => {
		assert.equal(String(input), `${desktopConnection.url}/health`);
		return Response.json({ instanceId: desktopConnection.instanceId });
	});
	const service = new ReviewDesktopConnectionService(
		mainProcessService as never,
		new TestStorage() as never,
		noProfileConfiguration as never,
		noSecrets as never,
	);
	t.after(() => service.dispose());

	assert.deepEqual(await service.getConnection(), {
		serverUrl: desktopConnection.url,
		token: desktopConnection.token,
		appSessionId: desktopConnection.appSessionId,
		sourceAccessMode: "api-only",
	});
});

test("install status shares concurrent scans and refreshes on subsequent checks", async (t) => {
	const service = serviceWith();
	t.after(() => service.dispose());
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		if (requests === 3) return Response.json({ error: "scan failed" }, { status: 500 });
		return Response.json({
			fingerprint: "test", stamp: null, stale: requests > 1, updateNeeded: false,
			shim: { path: "/tmp/review", installed: false, profileConfigured: false, onPath: false },
			trace: { enabled: false, configured: false, autoActivateRepositories: false, envPath: "/tmp/env", settingsPath: "/tmp/settings" },
			cli: null,
			connect: { command: "review", args: ["mcp"], prompts: { claude: "c", codex: "c", cursor: "c", opencode: "c", pi: "c" }, plugins: { claude: { label: "c" }, codex: { label: "c" }, cursor: { label: "c" }, opencode: { label: "c" }, pi: { label: "c" } } },
			legacySkills: [],
		});
	});

	const [first, second] = await Promise.all([
		service.getCliInstallStatus(),
		service.getCliInstallStatus(),
	]);
	assert.equal(first.stale, false);
	assert.equal(second.stale, false);
	assert.equal(requests, 1);
	assert.equal((await service.getCliInstallStatus()).stale, true);
	assert.equal(requests, 2);
	await assert.rejects(service.getCliInstallStatus(), /scan failed/);
	assert.equal((await service.getCliInstallStatus()).stale, true);
	assert.equal(requests, 4);
});

test("tutorial auto-prepare runs at most once per app process", async (t) => {
	const service = serviceWith();
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		return Response.json({ ok: true });
	});

	const first = service.prepareTutorial();
	assert.strictEqual(service.prepareTutorial(), first);
	await first;
	await service.prepareTutorial();

	assert.equal(requests, 1);
	service.dispose();
});

test("a failed tutorial auto-prepare is not retried on Welcome activation", async (t) => {
	const service = serviceWith();
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		return Response.json({ error: "no agent" }, { status: 409 });
	});

	await assert.rejects(service.prepareTutorial(), /no agent/);
	await service.prepareTutorial();

	assert.equal(requests, 1);
	service.dispose();
});

test("tutorial deletion suppresses auto-prepare across restarts until explicit open", async (t) => {
	const storage = new TestStorage();
	const requests: string[] = [];
	mockFetch(t, async (input, init) => {
		const url = String(input);
		requests.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/tutorial/open")) {
			return Response.json({
				kind: "api",
				reviewUuid: uuid,
				title: "Tutorial",
			});
		}
		return Response.json({ ok: true });
	});

	const deletingService = serviceWith(storage);
	await deletingService.deleteTutorial();
	deletingService.dispose();

	const suppressedService = serviceWith(storage);
	await suppressedService.prepareTutorial();
	assert.equal(requests.length, 1);
	await suppressedService.openTutorial();
	assert.equal(requests.length, 2);
	assert.match(requests[1] ?? "", /POST .*\/tutorial\/open$/);
	suppressedService.dispose();

	const restoredService = serviceWith(storage);
	await restoredService.prepareTutorial();
	assert.equal(requests.length, 3);
	assert.match(requests[2] ?? "", /POST .*\/tutorial\/prepare$/);
	restoredService.dispose();
});

test("passes automatic command updates to the server without enabling optional integrations", async (t) => {
	const service = serviceWith();
	let requestBody: unknown;
	mockFetch(t, async (_url, init) => {
		requestBody = JSON.parse(String(init?.body));
		return Response.json({ ok: true, output: "updated" });
	});
	await service.applyCliInstall({ shim: false, autoUpdate: true });
	assert.deepEqual(requestBody, { shim: false, autoUpdate: true });
});

test("creates an API-only loopback profile with metadata and token in separate stores", async (t) => {
	const settings = new Map<string, unknown>();
	const secrets = new Map<string, string>();
	const calls: Array<{ command: string; arg: unknown }> = [];
	const mainProcessService = {
		getChannel() {
			return {
				call(command: string, arg: unknown) {
					calls.push({ command, arg });
					if (command === "getAppSessionId") return Promise.resolve("remote-app-session");
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
		set(key: string, value: string) {
			secrets.set(key, value);
			return Promise.resolve();
		},
		delete(key: string) {
			secrets.delete(key);
			return Promise.resolve();
		},
	};
	const service = new ReviewDesktopConnectionService(
		mainProcessService as never,
		new TestStorage() as never,
		configurationService as never,
		secretStorageService as never,
	);
	t.after(() => service.dispose());
	const requests: string[] = [];
	mockFetch(t, async (input, init) => {
		requests.push(String(input));
		assert.equal(new Headers(init?.headers).get("x-review-token"), "saved-token");
		if (String(input).endsWith("/health")) {
			return Response.json({ ok: true, instanceId: "remote-instance" });
		}
		return Response.json({ desktopAvailable: false, softwareMapEnabled: false, scratchpadEnabled: false });
	});

	await service.createAndActivateRemoteProfile({
		name: "Forwarded devbox",
		serverUrl: "http://127.0.0.1:5500/",
		token: "saved-token",
		externalSourceOpener: {
			executable: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
			authority: "development-host",
		},
	});

	const metadata = settings.get(REVIEW_SERVER_PROFILE_SETTING) as Record<string, unknown>;
	assert.deepEqual(metadata, {
		id: metadata.id,
		name: "Forwarded devbox",
		serverUrl: "http://127.0.0.1:5500",
		sourceAccessMode: "api-only",
		externalSourceOpener: {
			executable: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
			authority: "development-host",
		},
	});
	assert.equal(typeof metadata.id, "string");
	assert.equal(JSON.stringify(metadata).includes("saved-token"), false);
	assert.equal(JSON.stringify(metadata).includes("sshPassword"), false);
	assert.equal(JSON.stringify(metadata).includes("privateKey"), false);
	assert.deepEqual([...secrets.values()], ["saved-token"]);
	assert.deepEqual(requests, [
		"http://127.0.0.1:5500/health",
		"http://127.0.0.1:5500/reviews-api/capabilities",
	]);
	assert.deepEqual(calls.map(({ command }) => command), ["getAppSessionId", "activateRemoteProfile"]);
	assert.deepEqual(await service.getConnection(), {
		serverUrl: "http://127.0.0.1:5500",
		token: "saved-token",
		appSessionId: "remote-app-session",
		sourceAccessMode: "api-only",
	});
});

test("invalid, unreachable, and incompatible remote profiles never fall back to embedded data", async (t) => {
	const profile = {
		id: "remote-profile",
		name: "Remote server",
		serverUrl: "http://127.0.0.1:5500",
		sourceAccessMode: "api-only",
	} as const;
	const scenarios: Array<{
		name: string;
		fetch: typeof fetch;
		error: RegExp;
	}> = [
		{
			name: "invalid token",
			fetch: async () => Response.json({ error: "Unauthorized" }, { status: 401 }),
			error: /rejected the token/,
		},
		{
			name: "unreachable endpoint",
			fetch: async () => { throw new TypeError("connect refused"); },
			error: /is unreachable/,
		},
		{
			name: "incompatible server",
			fetch: async (input) => String(input).endsWith("/health")
				? Response.json({ ok: true, instanceId: "remote-instance" })
				: Response.json({ unexpected: true }),
			error: /not compatible/,
		},
	];
	for (const scenario of scenarios) {
		await t.test(scenario.name, async (t) => {
			let embeddedRequests = 0;
			let remoteActivations = 0;
			mockFetch(t, scenario.fetch);
			const service = new ReviewDesktopConnectionService(
				{
					getChannel() {
						return {
							call(command: string) {
								if (command === "getAppSessionId") return Promise.resolve("app-session");
								if (command === "activateRemoteProfile") remoteActivations += 1;
								else embeddedRequests += 1;
								return Promise.resolve(undefined);
							},
						};
					},
				} as never,
				new TestStorage() as never,
				{ getValue: () => profile } as never,
				{ get: (key: string) => Promise.resolve(key === reviewServerProfileTokenKey(profile.id) ? "bad-token" : undefined) } as never,
			);
			t.after(() => service.dispose());
			await assert.rejects(service.getConnection(), scenario.error);
			assert.equal(embeddedRequests, 0);
			assert.equal(remoteActivations, 0);
		});
	}
});
