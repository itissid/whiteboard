/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from "../../../nls.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../../platform/notification/common/notification.js";
import { IQuickInputService } from "../../../platform/quickinput/common/quickInput.js";
import { IHostService } from "../../../workbench/services/host/browser/host.js";
import type { CreateRemoteReviewServerProfileInput } from "../../common/reviewServerProfile.js";
import { IReviewDesktopConnectionService } from "../../services/reviewDesktopConnectionService.js";

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

class ConnectRemoteReviewServerAction extends Action2 {
	constructor() {
		super({
			id: "review.connectRemoteServer",
			title: localize2("review.connectRemoteServer", "Whiteboard: Connect to Review Server..."),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		try {
			await createRemoteProfileFromPrompts(
				accessor.get(IQuickInputService),
				accessor.get(IReviewDesktopConnectionService),
				accessor.get(IHostService),
			);
		} catch (error) {
			accessor.get(INotificationService).error(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}

registerAction2(ConnectRemoteReviewServerAction);
