/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from "../../../base/common/codicons.js";
import { ICodeEditorService } from "../../../editor/browser/services/codeEditorService.js";
import { localize2 } from "../../../nls.js";
import { Action2, MenuId, registerAction2 } from "../../../platform/actions/common/actions.js";
import { IConfigurationService } from "../../../platform/configuration/common/configuration.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { IMainProcessService } from "../../../platform/ipc/common/mainProcessService.js";
import { INotificationService } from "../../../platform/notification/common/notification.js";
import { ResourceContextKey } from "../../../workbench/common/contextkeys.js";
import { REVIEW_DESKTOP_CHANNEL } from "../../common/reviewDesktopBootstrap.js";
import type { ReviewExternalSourceOpenResult } from "../../common/reviewExternalSourceOpener.js";
import {
	parseReviewServerProfile,
	REVIEW_SERVER_PROFILE_SETTING,
} from "../../common/reviewServerProfile.js";
import { REVIEW_API_SOURCE_SCHEME } from "../../common/reviewSourceView.js";
import { IReviewDesktopConnectionService } from "../../services/reviewDesktopConnectionService.js";
import { openActiveReviewSourceInVsCode } from "../../services/reviewExternalSourceOpenerService.js";

const OPEN_IN_VS_CODE_COMMAND_ID = "review.openApiSourceInVsCode";
const apiSourceEditor = ResourceContextKey.Scheme.isEqualTo(REVIEW_API_SOURCE_SCHEME);

class OpenApiSourceInVsCodeAction extends Action2 {
	constructor() {
		super({
			id: OPEN_IN_VS_CODE_COMMAND_ID,
			title: localize2("review.openApiSourceInVsCode", "Open in VS Code (Remote-SSH)"),
			icon: Codicon.openInProduct,
			f1: true,
			precondition: apiSourceEditor,
			menu: {
				id: MenuId.EditorTitle,
				group: "navigation",
				order: 25,
				when: apiSourceEditor,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const notifications = accessor.get(INotificationService);
		try {
			const codeEditors = accessor.get(ICodeEditorService);
			const editor = codeEditors.getFocusedCodeEditor() ?? codeEditors.getActiveCodeEditor();
			const profile = parseReviewServerProfile(
				accessor.get(IConfigurationService).getValue(REVIEW_SERVER_PROFILE_SETTING),
			);
			if (!profile) throw new Error("Open in VS Code requires an active Review Server Connection Profile.");
			const channel = accessor.get(IMainProcessService).getChannel(REVIEW_DESKTOP_CHANNEL);
			await openActiveReviewSourceInVsCode({
				connection: await accessor.get(IReviewDesktopConnectionService).getConnection(),
				profile,
				editor,
				processAdapter: {
					open: request => channel.call<ReviewExternalSourceOpenResult>("openExternalSource", request),
				},
			});
			notifications.info(
				"VS Code accepted the source-open request. Remote-SSH connection, authentication, workspace trust, and file reveal continue in VS Code.",
			);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : String(error));
		}
	}
}

registerAction2(OpenApiSourceInVsCodeAction);
