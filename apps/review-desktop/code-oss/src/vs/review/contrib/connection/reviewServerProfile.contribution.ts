/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from "../../../nls.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../../platform/notification/common/notification.js";
import { IQuickInputService, type IQuickPickItem } from "../../../platform/quickinput/common/quickInput.js";
import { IHostService } from "../../../workbench/services/host/browser/host.js";
import type {
	CreateRemoteReviewServerProfileInput,
	ReviewServerConnectionProfile,
} from "../../common/reviewServerProfile.js";
import {
	IReviewDesktopConnectionService,
	type ReviewServerProfilesSnapshot,
} from "../../services/reviewDesktopConnectionService.js";

export const REVIEW_SWITCH_PROFILE_COMMAND = "review.switchReviewServerProfile";
export const REVIEW_EDIT_ACTIVE_PROFILE_COMMAND = "review.editActiveReviewServerProfile";
export const REVIEW_RETRY_PROFILE_COMMAND = "review.retryReviewServerProfile";

interface ReviewServerProfilePickItem extends IQuickPickItem {
	readonly id: string;
}

function profilePickItems(snapshot: ReviewServerProfilesSnapshot): ReviewServerProfilePickItem[] {
	return snapshot.profiles.map(profile => ({
		id: profile.id,
		label: profile.name,
		description: `${profile.id === snapshot.activeProfileId ? "Active · " : ""}${profile.serverUrl}`,
	}));
}

export async function createRemoteProfileFromPrompts(
	quickInput: IQuickInputService,
	connection: IReviewDesktopConnectionService,
	host: IHostService,
): Promise<void> {
	const name = await quickInput.input({
		prompt: "Name this Review Server connection",
		placeHolder: "Development server",
		ignoreFocusLost: true,
	});
	if (name === undefined) return;
	const serverUrl = await quickInput.input({
		prompt: "Enter the Review Server URL",
		placeHolder: "http://127.0.0.1:5500",
		ignoreFocusLost: true,
	});
	if (serverUrl === undefined) return;
	const token = await quickInput.input({
		prompt: "Enter the Review Server Token",
		password: true,
		ignoreFocusLost: true,
	});
	if (token === undefined) return;
	const executable = await quickInput.input({
		prompt: "Enter the Microsoft VS Code CLI executable path (leave blank to skip)",
		placeHolder: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
		ignoreFocusLost: true,
	});
	if (executable === undefined) return;
	let externalSourceOpener: CreateRemoteReviewServerProfileInput["externalSourceOpener"];
	if (executable.trim()) {
		const authority = await quickInput.input({
			prompt: "Enter the VS Code Remote-SSH authority",
			placeHolder: "development-host",
			ignoreFocusLost: true,
		});
		if (authority === undefined) return;
		externalSourceOpener = { executable, authority };
	}
	await connection.createAndActivateRemoteProfile({
		name,
		serverUrl,
		token,
		...(externalSourceOpener ? { externalSourceOpener } : {}),
	});
	await host.reload();
}

export async function switchRemoteProfileFromPicker(
	quickInput: IQuickInputService,
	connection: IReviewDesktopConnectionService,
	host: IHostService,
): Promise<void> {
	const snapshot = connection.getRemoteProfiles();
	const selected = await quickInput.pick(
		profilePickItems(snapshot),
		{ placeHolder: "Select a Review Server Connection Profile" },
	);
	if (!selected || selected.id === snapshot.activeProfileId) return;
	await connection.switchRemoteProfile(selected.id);
	await host.reload();
}

async function editRemoteProfileFromPrompts(
	profile: ReviewServerConnectionProfile,
	quickInput: IQuickInputService,
	connection: IReviewDesktopConnectionService,
	host: IHostService,
	reload: boolean,
): Promise<void> {
	const name = await quickInput.input({
		prompt: "Name this Review Server connection",
		value: profile.name,
		ignoreFocusLost: true,
	});
	if (name === undefined) return;
	const serverUrl = await quickInput.input({
		prompt: "Enter the Review Server URL",
		value: profile.serverUrl,
		ignoreFocusLost: true,
	});
	if (serverUrl === undefined) return;
	const token = await quickInput.input({
		prompt: "Enter a replacement Review Server Token, or leave blank to keep the saved token",
		password: true,
		ignoreFocusLost: true,
	});
	if (token === undefined) return;
	await connection.editRemoteProfile(profile.id, {
		name,
		serverUrl,
		...(token ? { token } : {}),
	});
	if (reload) await host.reload();
}

export async function editActiveRemoteProfileFromPrompts(
	quickInput: IQuickInputService,
	connection: IReviewDesktopConnectionService,
	host: IHostService,
): Promise<void> {
	const snapshot = connection.getRemoteProfiles();
	const profile = snapshot.profiles.find(profile => profile.id === snapshot.activeProfileId);
	if (!profile) throw new Error("No active Review Server Connection Profile is available to edit.");
	await editRemoteProfileFromPrompts(profile, quickInput, connection, host, true);
}

export async function editRemoteProfileFromPicker(
	quickInput: IQuickInputService,
	connection: IReviewDesktopConnectionService,
	host: IHostService,
): Promise<void> {
	const snapshot = connection.getRemoteProfiles();
	const selected = await quickInput.pick(
		profilePickItems(snapshot),
		{ placeHolder: "Edit a Review Server Connection Profile" },
	);
	if (!selected) return;
	const profile = snapshot.profiles.find(profile => profile.id === selected.id)!;
	await editRemoteProfileFromPrompts(
		profile,
		quickInput,
		connection,
		host,
		profile.id === snapshot.activeProfileId,
	);
}

export async function removeRemoteProfileFromPicker(
	quickInput: IQuickInputService,
	connection: IReviewDesktopConnectionService,
	host: IHostService,
): Promise<void> {
	const snapshot = connection.getRemoteProfiles();
	const selected = await quickInput.pick(
		profilePickItems(snapshot),
		{ placeHolder: "Remove a Review Server Connection Profile" },
	);
	if (!selected) return;
	const removedActiveProfile = selected.id === snapshot.activeProfileId;
	await connection.removeRemoteProfile(selected.id);
	if (removedActiveProfile) await host.reload();
}

async function runProfileAction(
	accessor: ServicesAccessor,
	action: (
		quickInput: IQuickInputService,
		connection: IReviewDesktopConnectionService,
		host: IHostService,
	) => Promise<void>,
): Promise<void> {
	try {
		await action(
			accessor.get(IQuickInputService),
			accessor.get(IReviewDesktopConnectionService),
			accessor.get(IHostService),
		);
	} catch (error) {
		accessor.get(INotificationService).error(error instanceof Error ? error.message : String(error));
	}
}

class ConnectRemoteReviewServerAction extends Action2 {
	constructor() {
		super({ id: "review.connectRemoteServer", title: localize2("review.connectRemoteServer", "Whiteboard: Add Review Server Profile..."), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runProfileAction(accessor, createRemoteProfileFromPrompts);
	}
}

class SwitchRemoteReviewServerAction extends Action2 {
	constructor() {
		super({ id: REVIEW_SWITCH_PROFILE_COMMAND, title: localize2("review.switchReviewServerProfile", "Whiteboard: Switch Review Server Profile..."), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runProfileAction(accessor, switchRemoteProfileFromPicker);
	}
}

class EditRemoteReviewServerAction extends Action2 {
	constructor() {
		super({ id: "review.editReviewServerProfile", title: localize2("review.editReviewServerProfile", "Whiteboard: Edit Review Server Profile..."), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runProfileAction(accessor, editRemoteProfileFromPicker);
	}
}

class EditActiveRemoteReviewServerAction extends Action2 {
	constructor() {
		super({ id: REVIEW_EDIT_ACTIVE_PROFILE_COMMAND, title: localize2("review.editActiveReviewServerProfile", "Whiteboard: Edit Active Review Server Profile..."), f1: false });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runProfileAction(accessor, editActiveRemoteProfileFromPrompts);
	}
}

class RemoveRemoteReviewServerAction extends Action2 {
	constructor() {
		super({ id: "review.removeReviewServerProfile", title: localize2("review.removeReviewServerProfile", "Whiteboard: Remove Review Server Profile..."), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runProfileAction(accessor, removeRemoteProfileFromPicker);
	}
}

class RetryRemoteReviewServerAction extends Action2 {
	constructor() {
		super({ id: REVIEW_RETRY_PROFILE_COMMAND, title: localize2("review.retryReviewServerProfile", "Whiteboard: Retry Active Review Server Profile"), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runProfileAction(accessor, async (_quickInput, connection, host) => {
			const state = await connection.retryRemoteProfile();
			if (state.status === "disconnected") throw new Error(state.message);
			await host.reload();
		});
	}
}

registerAction2(ConnectRemoteReviewServerAction);
registerAction2(SwitchRemoteReviewServerAction);
registerAction2(EditRemoteReviewServerAction);
registerAction2(EditActiveRemoteReviewServerAction);
registerAction2(RemoveRemoteReviewServerAction);
registerAction2(RetryRemoteReviewServerAction);
