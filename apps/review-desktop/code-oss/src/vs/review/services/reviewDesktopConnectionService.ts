/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter,Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { generateUuid } from "../../base/common/uuid.js";
import { ConfigurationTarget, IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IMainProcessService } from "../../platform/ipc/common/mainProcessService.js";
import { ISecretStorageService } from "../../platform/secrets/common/secrets.js";
import { IStorageService,StorageScope,StorageTarget } from "../../platform/storage/common/storage.js";
import {
REVIEW_DESKTOP_CHANNEL,
REVIEW_DESKTOP_CONNECTION_VERSION,
type ReviewDesktopConnection,
type ReviewSourceAccessMode,
} from "../common/reviewDesktopBootstrap.js";
import { consumeReviewEventStream } from "../common/reviewEventStream.js";
import {
type JsonValue,
	type ReviewDiffrConfig,
	type ReviewDiffrSummarizerInput,
	isJsonObject,
	parseReviewDiffrConfig,
parseReviewCliInstallApplyResponse,
parseReviewCliInstallStatus,
parseReviewDesktopVerbFrame,
parseReviewTutorialOpenResponse,
type ReviewCliInstallApplyResponse,
type ReviewCliInstallStatus,
type ReviewTutorialOpenResponse,
type ReviewVerbResponse
} from "../common/reviewProtocol.js";
import { reconnectUntilAborted } from "../common/reviewReconnect.js";
import {
	parseReviewServerProfile,
	parseReviewServerProfiles,
	REVIEW_SERVER_PROFILE_SETTING,
	reviewServerProfileTokenKey,
	type CreateRemoteReviewServerProfileInput,
	type ReviewServerConnectionProfile,
	type ReviewServerConnectionProfiles,
	type UpdateRemoteReviewServerProfileInput,
} from "../common/reviewServerProfile.js";

const REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY = "review.tutorial.autoPrepareSuppressed.v1";

export interface ReviewServerConnection {
	readonly serverUrl: string;
	readonly token: string;
	/** The launch's id, minted by the main process; canvas telemetry carries it. */
	readonly appSessionId: string;
	/** Whether server filesystem paths are addressable by this Desktop. */
	readonly sourceAccessMode: ReviewSourceAccessMode;
}

export type ReviewServerDisconnectedReason = "unreachable" | "rejected-token" | "missing-token" | "incompatible";

export type ReviewServerConnectionState =
	| { readonly status: "uninitialized" }
	| { readonly status: "connecting"; readonly profile: ReviewServerConnectionProfile }
	| { readonly status: "connected"; readonly profile?: ReviewServerConnectionProfile }
	| {
		readonly status: "disconnected";
		readonly profile: ReviewServerConnectionProfile;
		readonly reason: ReviewServerDisconnectedReason;
		readonly message: string;
	};

export interface ReviewServerProfilesSnapshot {
	readonly profiles: readonly ReviewServerConnectionProfile[];
	readonly activeProfileId?: string;
}

class ReviewServerProfileConnectionError extends Error {
	constructor(
		readonly reason: ReviewServerDisconnectedReason,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export const IReviewDesktopConnectionService = createDecorator<IReviewDesktopConnectionService>(
	"reviewDesktopConnectionService",
);

export interface IReviewDesktopConnectionService {
	readonly _serviceBrand: undefined;
	readonly onDidFail: Event<Error>;
	readonly onDidChangeLists: Event<void>;
	/** Fires at control-stream connection/disconnection boundaries, before reuse. */
	readonly onDidChangeConnection: Event<void>;
	readonly onDidChangeConnectionState: Event<ReviewServerConnectionState>;
	initialize(): Promise<void>;
	getConnection(): Promise<ReviewServerConnection>;
	getConnectionState(): ReviewServerConnectionState;
	getRemoteProfiles(): ReviewServerProfilesSnapshot;
	createAndActivateRemoteProfile(input: CreateRemoteReviewServerProfileInput): Promise<ReviewServerConnectionState>;
	editRemoteProfile(profileId: string, input: UpdateRemoteReviewServerProfileInput): Promise<ReviewServerConnectionState>;
	switchRemoteProfile(profileId: string): Promise<ReviewServerConnectionState>;
	removeRemoteProfile(profileId: string): Promise<ReviewServerConnectionState>;
	retryRemoteProfile(): Promise<ReviewServerConnectionState>;
	readDiffrConfig(): Promise<ReviewDiffrConfig>;
	saveDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<ReviewDiffrConfig>;
	testDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<string>;
	setDiffrConfigValue(key: string, value: JsonValue): Promise<ReviewDiffrConfig>;
	/** The scratchpad preference: a server preference, since the review server reads it. */
	readScratchpadEnabled(): Promise<boolean>;
	setScratchpadEnabled(enabled: boolean): Promise<boolean>;
	getTutorialStatus(): Promise<{ version: 1; reviewUuid: string | null }>;
	prepareTutorial(): Promise<void>;
	openTutorial(): Promise<ReviewTutorialOpenResponse>;
	deleteTutorial(): Promise<void>;
	getCliInstallStatus(): Promise<ReviewCliInstallStatus>;
	applyCliInstall(request: {
		autoUpdate?: boolean;
		shim?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<ReviewCliInstallApplyResponse>;
	removeCliInstall(request: { shim?: boolean; trace?: true }): Promise<void>;
	removeLegacySkills(): Promise<void>;
	finishCliInstallUpdate(): Promise<void>;
	declineCliInstall(): Promise<void>;
	skipCliInstallPrompts(): Promise<void>;
	resetCliInstallPrompts(): Promise<void>;
	attachControl(dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>): void;
}

export class ReviewDesktopConnectionService extends Disposable implements IReviewDesktopConnectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLists = this._register(new Emitter<void>());
	readonly onDidChangeLists = this._onDidChangeLists.event;
	private readonly _onDidFail = this._register(new Emitter<Error>());
	readonly onDidFail = this._onDidFail.event;
	private readonly connectionChanged = this._register(new Emitter<void>());
	readonly onDidChangeConnection = this.connectionChanged.event;
	private readonly connectionStateChanged = this._register(new Emitter<ReviewServerConnectionState>());
	readonly onDidChangeConnectionState = this.connectionStateChanged.event;

	private initializePromise: Promise<void> | null = null;
	private connectionState: ReviewServerConnectionState = { status: "uninitialized" };
	private tutorialPreparePromise: Promise<void> | undefined;
	private tutorialPrepareAttempted = false;
	private cliInstallStatusPromise: Promise<ReviewCliInstallStatus> | undefined;
	private readonly controller = new AbortController();
	private controlAttached = false;
	private controlDispatch: ((value: JsonValue) => Promise<ReviewVerbResponse>) | undefined;
	/**
	 * The main process owns the embedded server's endpoint and credentials and
	 * publishes them only once it has validated the server's ready event.
	 */
	private connection: ReviewDesktopConnection | undefined;
	private get serverUrl(): string {
		return this.requireConnection().url;
	}
	private get token(): string {
		return this.requireConnection().token;
	}
	private get instanceId(): string {
		return this.requireConnection().instanceId;
	}

	constructor(
		@IMainProcessService
		private readonly mainProcessService: IMainProcessService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super();
	}

	private requireConnection(): ReviewDesktopConnection {
		if (!this.connection) {
			throw new Error("The Whiteboard connection is not established yet.");
		}
		return this.connection;
	}

	private setConnectionState(state: ReviewServerConnectionState): void {
		this.connectionState = state;
		this.connectionStateChanged.fire(state);
	}

	private readRemoteProfiles(): ReviewServerConnectionProfiles | undefined {
		return parseReviewServerProfiles(this.configurationService.getValue(REVIEW_SERVER_PROFILE_SETTING));
	}

	private async saveRemoteProfiles(profiles: ReviewServerConnectionProfiles | undefined): Promise<void> {
		await this.configurationService.updateValue(
			REVIEW_SERVER_PROFILE_SETTING,
			profiles ?? null,
			ConfigurationTarget.USER,
		);
	}

	private async connect(): Promise<void> {
		if (this.connection) return;
		const profiles = this.readRemoteProfiles();
		if (profiles) {
			const profile = profiles.profiles.find(profile => profile.id === profiles.activeProfileId)!;
			const state = await this.establishRemoteConnection(profile);
			if (state.status === "disconnected") throw new Error(state.message);
			return;
		}
		const connection = (await this.mainProcessService
			.getChannel(REVIEW_DESKTOP_CHANNEL)
			.call("getConnection")) as ReviewDesktopConnection;
		if (connection?.version !== REVIEW_DESKTOP_CONNECTION_VERSION) {
			throw new Error(`Unsupported Whiteboard Desktop connection version: ${String(connection?.version)}.`);
		}
		this.connection = connection;
		this.setConnectionState({ status: "connected" });
	}

	initialize(): Promise<void> {
		if (this.connectionState.status === "disconnected") {
			return Promise.reject(new Error(this.connectionState.message));
		}
		this.initializePromise ??= this.initializeGlobalState().catch((error) => {
			this.initializePromise = null;
			throw error;
		});
		return this.initializePromise;
	}

	async getConnection(): Promise<ReviewServerConnection> {
		await this.initialize();
		const { token, appSessionId, sourceAccessMode } = this.requireConnection();
		return { serverUrl: this.serverUrl, token, appSessionId, sourceAccessMode };
	}

	getConnectionState(): ReviewServerConnectionState {
		return this.connectionState;
	}

	getRemoteProfiles(): ReviewServerProfilesSnapshot {
		const profiles = this.readRemoteProfiles();
		return profiles
			? { profiles: profiles.profiles, activeProfileId: profiles.activeProfileId }
			: { profiles: [] };
	}

	async createAndActivateRemoteProfile(input: CreateRemoteReviewServerProfileInput): Promise<ReviewServerConnectionState> {
		if (!input.token) throw new Error("Enter a Review Server Token.");
		const profile = this.profileFromInput(generateUuid(), input);
		const current = this.readRemoteProfiles();
		const next: ReviewServerConnectionProfiles = {
			version: 1,
			activeProfileId: profile.id,
			profiles: [...(current?.profiles ?? []), profile],
		};
		const secretKey = reviewServerProfileTokenKey(profile.id);
		await this.secretStorageService.set(secretKey, input.token);
		try {
			await this.saveRemoteProfiles(next);
		} catch (error) {
			await this.secretStorageService.delete(secretKey);
			throw error;
		}
		return this.establishRemoteConnection(profile);
	}

	async editRemoteProfile(
		profileId: string,
		input: UpdateRemoteReviewServerProfileInput,
	): Promise<ReviewServerConnectionState> {
		const current = this.requireRemoteProfiles();
		const index = current.profiles.findIndex(profile => profile.id === profileId);
		if (index === -1) throw new Error("The Review Server Connection Profile does not exist.");
		const profile = this.profileFromInput(profileId, {
			...input,
			externalSourceOpener: current.profiles[index]!.externalSourceOpener,
		});
		const profiles = [...current.profiles];
		profiles[index] = profile;
		const next = { ...current, profiles };
		const secretKey = reviewServerProfileTokenKey(profileId);
		const previousToken = await this.secretStorageService.get(secretKey);
		if (input.token !== undefined && !input.token) throw new Error("Enter a Review Server Token.");
		if (!previousToken && input.token === undefined) {
			throw new Error(`The Review Server Token for “${profile.name}” is missing.`);
		}
		if (input.token !== undefined) await this.secretStorageService.set(secretKey, input.token);
		try {
			await this.saveRemoteProfiles(next);
		} catch (error) {
			if (input.token !== undefined) {
				if (previousToken) await this.secretStorageService.set(secretKey, previousToken);
				else await this.secretStorageService.delete(secretKey);
			}
			throw error;
		}
		return current.activeProfileId === profileId
			? this.establishRemoteConnection(profile)
			: this.connectionState;
	}

	async switchRemoteProfile(profileId: string): Promise<ReviewServerConnectionState> {
		const current = this.requireRemoteProfiles();
		const profile = current.profiles.find(profile => profile.id === profileId);
		if (!profile) throw new Error("The Review Server Connection Profile does not exist.");
		await this.saveRemoteProfiles({ ...current, activeProfileId: profileId });
		return this.establishRemoteConnection(profile);
	}

	async removeRemoteProfile(profileId: string): Promise<ReviewServerConnectionState> {
		const current = this.requireRemoteProfiles();
		const profile = current.profiles.find(profile => profile.id === profileId);
		if (!profile) throw new Error("The Review Server Connection Profile does not exist.");
		const remaining = current.profiles.filter(profile => profile.id !== profileId);
		if (current.activeProfileId === profileId && remaining.length > 0) {
			throw new Error("Switch to another profile before removing the active Review Server Connection Profile.");
		}
		if (current.activeProfileId !== profileId) {
			await this.saveRemoteProfiles({ ...current, profiles: remaining });
			await this.secretStorageService.delete(reviewServerProfileTokenKey(profileId));
			return this.connectionState;
		}
		await this.saveRemoteProfiles(undefined);
		await this.secretStorageService.delete(reviewServerProfileTokenKey(profileId));
		this.connection = undefined;
		this.initializePromise = null;
		this.setConnectionState({ status: "uninitialized" });
		await this.mainProcessService.getChannel(REVIEW_DESKTOP_CHANNEL).call("activateEmbeddedConnection");
		await this.initialize();
		this.connectionChanged.fire();
		return this.connectionState;
	}

	async retryRemoteProfile(): Promise<ReviewServerConnectionState> {
		const current = this.requireRemoteProfiles();
		const profile = current.profiles.find(profile => profile.id === current.activeProfileId)!;
		return this.establishRemoteConnection(profile);
	}

	private requireRemoteProfiles(): ReviewServerConnectionProfiles {
		const profiles = this.readRemoteProfiles();
		if (!profiles) throw new Error("No Review Server Connection Profiles are saved.");
		return profiles;
	}

	private profileFromInput(
		id: string,
		input: Pick<CreateRemoteReviewServerProfileInput, "name" | "serverUrl" | "externalSourceOpener">,
	): ReviewServerConnectionProfile {
		const profile = parseReviewServerProfile({
			id,
			name: input.name,
			serverUrl: input.serverUrl,
			sourceAccessMode: "api-only",
			...(input.externalSourceOpener ? { externalSourceOpener: input.externalSourceOpener } : {}),
		});
		if (!profile) throw new Error("The Review Server Connection Profile is required.");
		return profile;
	}

	private async establishRemoteConnection(profile: ReviewServerConnectionProfile): Promise<ReviewServerConnectionState> {
		this.connection = undefined;
		this.initializePromise = null;
		this.setConnectionState({ status: "connecting", profile });
		try {
			const channel = this.mainProcessService.getChannel(REVIEW_DESKTOP_CHANNEL);
			await channel.call("activateRemoteProfile");
			const token = await this.secretStorageService.get(reviewServerProfileTokenKey(profile.id));
			if (!token) {
				throw new ReviewServerProfileConnectionError(
					"missing-token",
					`The Review Server Token for “${profile.name}” is missing.`,
				);
			}
			this.connection = await this.prepareRemoteConnection(profile, token);
			this.initializePromise = Promise.resolve();
			this.setConnectionState({ status: "connected", profile });
			this.connectionChanged.fire();
			return this.connectionState;
		} catch (error) {
			const failure = error instanceof ReviewServerProfileConnectionError
				? error
				: new ReviewServerProfileConnectionError(
					"incompatible",
					error instanceof Error ? error.message : String(error),
					{ cause: error },
				);
			this.setConnectionState({
				status: "disconnected",
				profile,
				reason: failure.reason,
				message: failure.message,
			});
			this.connectionChanged.fire();
			return this.connectionState;
		}
	}

	/**
	 * The dismissed review retention window. It is a server preference rather
	 * than a workbench setting because the reaper runs inside the review server.
	 * `null` means never reap.
	 */
	async readDiffrConfig(): Promise<ReviewDiffrConfig> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "diffr configuration");
		return parseReviewDiffrConfig(await response.json());
	}

	async setDiffrConfigValue(key: string, value: JsonValue): Promise<ReviewDiffrConfig> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config`, {
			method: "PUT",
			headers: {
				...this.authHeaders(),
				"content-type": "application/json",
			},
			body: JSON.stringify({ key, value }),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "diffr configuration");
		return parseReviewDiffrConfig(await response.json());
	}

	async readScratchpadEnabled(): Promise<boolean> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/preferences/scratchpad`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "scratchpad preference");
		return parseScratchpadPreference(await response.json());
	}

	async setScratchpadEnabled(enabled: boolean): Promise<boolean> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/preferences/scratchpad`, {
			method: "PUT",
			headers: { ...this.authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "scratchpad preference");
		return parseScratchpadPreference(await response.json());
	}

	async saveDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<ReviewDiffrConfig> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config/summarizer`, {
			method: "PUT",
			headers: { ...this.authHeaders(), "content-type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "summary settings");
		return parseReviewDiffrConfig(await response.json());
	}

	async testDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<string> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config/summarizer/test`, {
			method: "POST",
			headers: { ...this.authHeaders(), "content-type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(95_000),
		});
		await this.requireOk(response, "summary test");
		const result: unknown = await response.json();
		if (!isJsonObject(result) || typeof result.summary !== "string") throw new Error("Malformed summary test response.");
		return result.summary;
	}

	async getTutorialStatus(): Promise<{ version: 1; reviewUuid: string | null }> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/status`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(5_000),
		});
		await this.requireOk(response, "Whiteboard tutorial status");
		const payload = (await response.json()) as {
			version?: unknown;
			reviewUuid?: unknown;
		};
		if (payload.version !== 1 || (payload.reviewUuid !== null && typeof payload.reviewUuid !== "string")) {
			throw new Error("Whiteboard tutorial status is invalid.");
		}
		return { version: 1, reviewUuid: payload.reviewUuid as string | null };
	}

	prepareTutorial(): Promise<void> {
		if (this.storageService.getBoolean(REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION, false)) {
			return Promise.resolve();
		}
		if (this.tutorialPreparePromise) return this.tutorialPreparePromise;
		if (this.tutorialPrepareAttempted) return Promise.resolve();
		this.tutorialPrepareAttempted = true;
		const operation = this.requestTutorialPreparation();
		this.tutorialPreparePromise = operation;
		const clearOperation = () => {
			if (this.tutorialPreparePromise === operation) {
				this.tutorialPreparePromise = undefined;
			}
		};
		void operation.then(clearOperation, clearOperation);
		return operation;
	}

	private async requestTutorialPreparation(): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/prepare`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "Whiteboard tutorial preparation");
	}

	async openTutorial(): Promise<ReviewTutorialOpenResponse> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/open`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "Whiteboard tutorial open");
		const payload = parseReviewTutorialOpenResponse(await response.json());
		this.tutorialPrepareAttempted = true;
		this.storageService.remove(REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION);
		return payload;
	}

	async deleteTutorial(): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial`, {
			method: "DELETE",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "Whiteboard tutorial delete");
		this.tutorialPreparePromise = undefined;
		this.tutorialPrepareAttempted = true;
		this.storageService.store(
			REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY,
			true,
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
		this._onDidChangeLists.fire();
	}

	/** Raises the server's own error message when it sends one. */
	private async requireOk(response: Response, what: string): Promise<void> {
		if (response.ok) {
			return;
		}
		const payload = (await response.json().catch(() => ({}))) as {
			error?: unknown;
		};
		throw new Error(typeof payload.error === "string" ? payload.error : `${what} returned ${response.status}.`);
	}

	async getCliInstallStatus(): Promise<ReviewCliInstallStatus> {
		await this.initialize();
		this.cliInstallStatusPromise ??= (async () => {
			const response = await fetch(`${this.serverUrl}/install/status`, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(30_000),
			});
			await this.requireOk(response, "Whiteboard install status");
			return parseReviewCliInstallStatus(await response.json());
		})().finally(() => {
			this.cliInstallStatusPromise = undefined;
		});
		return this.cliInstallStatusPromise;
	}

	async applyCliInstall(request: {
		autoUpdate?: boolean;
		shim?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<ReviewCliInstallApplyResponse> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/apply`, {
			method: "POST",
			headers: {
				...this.authHeaders(),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				...(request.autoUpdate ? { autoUpdate: true } : {}),
				...(request.shim !== undefined ? { shim: request.shim } : {}),
				...(request.trace !== undefined ? { trace: request.trace } : {}),
			}),
			signal: AbortSignal.timeout(120_000),
		});
		const payload: JsonValue = await response.json().catch(() => ({}));
		if (!response.ok) {
			const detail = payload as { output?: unknown; error?: unknown };
			throw new Error(
				typeof detail.output === "string" && detail.output
					? detail.output
					: typeof detail.error === "string"
						? detail.error
						: `Whiteboard install returned ${response.status}.`,
			);
		}
		return parseReviewCliInstallApplyResponse(payload);
	}

	async removeCliInstall(request: { shim?: boolean; trace?: true }): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/remove`, {
			method: "POST",
			headers: {
				...this.authHeaders(),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				...(request.shim ? { shim: true } : {}),
				...(request.trace ? { trace: true } : {}),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`Whiteboard install remove returned ${response.status}.`);
		}
	}

	async removeLegacySkills(): Promise<void> {
		await this.postCliInstallVerb("legacy-skills/remove");
	}

	async finishCliInstallUpdate(): Promise<void> {
		await this.postCliInstallVerb("finish-update");
	}

	async declineCliInstall(): Promise<void> {
		await this.postCliInstallVerb("decline");
	}

	async skipCliInstallPrompts(): Promise<void> {
		await this.postCliInstallVerb("skip");
	}

	async resetCliInstallPrompts(): Promise<void> {
		await this.postCliInstallVerb("reset");
	}

	private async postCliInstallVerb(verb: "decline" | "skip" | "reset" | "legacy-skills/remove" | "finish-update"): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/${verb}`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`Whiteboard install ${verb} returned ${response.status}.`);
		}
	}

	attachControl(dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>): void {
		this.controlDispatch = dispatch;
		if (this.controlAttached) return;
		this.controlAttached = true;
		void this.initializeAndMaintainControl((value) => {
			const current = this.controlDispatch;
			return current
				? current(value)
				: Promise.resolve({
						ok: false,
						error: "Whiteboard control handler is unavailable.",
					});
		});
	}

	override dispose(): void {
		this.controller.abort();
		super.dispose();
	}

	private async initializeGlobalState(): Promise<void> {
		await this.connect();
		if (this.requireConnection().sourceAccessMode === "shared-filesystem") {
			await this.waitForHealth();
		}
	}

	private async initializeAndMaintainControl(
		dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>,
	): Promise<void> {
		await this.initialize();
		const state = this.connectionState;
		if (state.status === "connected" && state.profile) {
			try {
				await this.consumeControl(dispatch, () => undefined);
				if (!this.controller.signal.aborted) throw new Error("The Whiteboard control stream ended.");
			} catch (error) {
				if (!this.controller.signal.aborted) await this.disconnectRemoteControl(state.profile, error);
			}
			return;
		}
		await reconnectUntilAborted(
			this.controller.signal,
			async () => { await this.maintainControl(dispatch); },
			{
				onRetry: (error) => console.error("[Whiteboard] control channel stopped", error),
			},
		);
	}

	private async disconnectRemoteControl(
		profile: ReviewServerConnectionProfile,
		error: unknown,
	): Promise<void> {
		let failure = error instanceof ReviewServerProfileConnectionError ? error : undefined;
		if (!failure && this.connection) {
			try {
				await this.validateRemoteProfile(profile, this.connection.token);
			} catch (validationError) {
				if (validationError instanceof ReviewServerProfileConnectionError) failure = validationError;
			}
		}
		failure ??= new ReviewServerProfileConnectionError(
			"unreachable",
			`The Review Server “${profile.name}” is unreachable. Check the endpoint or external transport, then retry.`,
			{ cause: error },
		);
		if (
			this.connectionState.status !== "connected" ||
			this.connectionState.profile?.id !== profile.id
		) return;
		this.connection = undefined;
		this.initializePromise = null;
		this.setConnectionState({
			status: "disconnected",
			profile,
			reason: failure.reason,
			message: failure.message,
		});
		this.connectionChanged.fire();
	}

	private async waitForHealth(): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`${this.serverUrl}/health`, {
					signal: AbortSignal.timeout(1_000),
				});
				const value = (await response.json()) as { instanceId?: unknown };
				if (response.ok && value.instanceId === this.instanceId) return;
			} catch {
				// The utility host may still be starting.
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("The embedded Whiteboard server did not become healthy.");
	}

	private async prepareRemoteConnection(
		profile: ReviewServerConnectionProfile,
		token: string,
	): Promise<ReviewDesktopConnection> {
		const channel = this.mainProcessService.getChannel(REVIEW_DESKTOP_CHANNEL);
		const appSessionId = await channel.call<string>("getAppSessionId");
		const instanceId = await this.validateRemoteProfile(profile, token);
		return {
			version: REVIEW_DESKTOP_CONNECTION_VERSION,
			url: profile.serverUrl,
			token,
			instanceId,
			appSessionId,
			sourceAccessMode: profile.sourceAccessMode,
		};
	}

	private async validateRemoteProfile(profile: ReviewServerConnectionProfile, token: string): Promise<string> {
		const request = async (path: string): Promise<Response> => {
			try {
				const response = await fetch(`${profile.serverUrl}${path}`, {
					headers: { "x-review-token": token },
					signal: AbortSignal.timeout(5_000),
				});
				if (response.status === 401 || response.status === 403) {
					throw new ReviewServerProfileConnectionError(
						"rejected-token",
						`The Review Server rejected the token for “${profile.name}”. Edit its credentials and retry.`,
					);
				}
				return response;
			} catch (error) {
				if (error instanceof ReviewServerProfileConnectionError) throw error;
				throw new ReviewServerProfileConnectionError(
					"unreachable",
					`The Review Server “${profile.name}” is unreachable. Check the endpoint or external transport, then retry.`,
					{ cause: error },
				);
			}
		};
		const health = await request("/health");
		const healthPayload = await health.json().catch(() => undefined) as { ok?: unknown; instanceId?: unknown } | undefined;
		if (!health.ok || healthPayload?.ok !== true || typeof healthPayload.instanceId !== "string" || !healthPayload.instanceId) {
			throw new ReviewServerProfileConnectionError(
				"incompatible",
				`The Review Server “${profile.name}” returned an incompatible health response.`,
			);
		}
		const capabilities = await request("/reviews-api/capabilities");
		const capabilityPayload = await capabilities.json().catch(() => undefined) as Record<string, unknown> | undefined;
		if (
			!capabilities.ok || !capabilityPayload ||
			typeof capabilityPayload.desktopAvailable !== "boolean" ||
			typeof capabilityPayload.softwareMapEnabled !== "boolean" ||
			typeof capabilityPayload.scratchpadEnabled !== "boolean"
		) {
			throw new ReviewServerProfileConnectionError(
				"incompatible",
				`The Review Server “${profile.name}” is not compatible with this Whiteboard Desktop.`,
			);
		}
		return healthPayload.instanceId;
	}


	private async maintainControl(dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>): Promise<void> {
		await reconnectUntilAborted(
			this.controller.signal,
			async (onConnected) => {
				await this.consumeControl(dispatch, onConnected);
				if (this.controller.signal.aborted) return;
				throw new Error("The Whiteboard control stream ended.");
			},
			{
				onExhausted: (error) => {
					throw error;
				},
			},
		);
	}

	private async consumeControl(
		dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>,
		onConnected: () => void,
	): Promise<void> {
		const url = new URL("/control", this.serverUrl);
		url.searchParams.set("token", this.token);
		const response = await fetch(url, { signal: this.controller.signal });
		if (response.status === 401 || response.status === 403) {
			const state = this.connectionState;
			const profileName = state.status === "connected" ? state.profile?.name : undefined;
			throw new ReviewServerProfileConnectionError(
				"rejected-token",
				profileName
					? `The Review Server rejected the token for “${profileName}”. Edit its credentials and retry.`
					: "The Review Server rejected the Desktop token.",
			);
		}
		if (!response.ok || !response.body) {
			throw new Error(`Desktop control returned ${response.status}.`);
		}
		this.connectionChanged.fire();
		onConnected();
		await consumeReviewEventStream(
			response.body,
			async (value) => {
				const frame = parseReviewDesktopVerbFrame(value);
				let verbResponse: ReviewVerbResponse;
				try {
					verbResponse = await dispatch(frame.request);
				} catch (error) {
					verbResponse = {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
				await fetch(`${this.serverUrl}/control/result`, {
					method: "POST",
					headers: {
						...this.authHeaders(),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						id: frame.id,
						response: verbResponse,
					}),
					signal: this.controller.signal,
				});
			},
			this.controller.signal,
		).finally(() => this.connectionChanged.fire());
	}

	private authHeaders(): Record<string, string> {
		return { "x-review-token": this.token };
	}
}

export async function reviewResponseError(response: Response, fallback: string): Promise<Error> {
	const payload = (await response.json().catch(() => null)) as {
		error?: unknown;
	} | null;
	return new Error(typeof payload?.error === "string" && payload.error ? payload.error : fallback);
}

function parseScratchpadPreference(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("enabled" in value) || typeof value.enabled !== "boolean") {
		throw new Error("scratchpad preference response is malformed.");
	}
	return value.enabled;
}
