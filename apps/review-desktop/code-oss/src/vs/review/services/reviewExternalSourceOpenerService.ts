/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from "../../base/common/uri.js";
import type {
	ReviewExternalSourceOpenRequest,
	ReviewExternalSourceOpenResult,
} from "../common/reviewExternalSourceOpener.js";
import type { ReviewServerConnectionProfile } from "../common/reviewServerProfile.js";
import { REVIEW_API_SOURCE_SCHEME } from "../common/reviewSourceView.js";
import type { ReviewServerConnection } from "./reviewDesktopConnectionService.js";
import { resolveReviewSourceDestination } from "./reviewSourceNavigator.js";

export interface ReviewExternalSourceProcessAdapter {
	open(request: ReviewExternalSourceOpenRequest): Promise<ReviewExternalSourceOpenResult>;
}

interface ReviewExternalSourceEditor {
	getModel(): { readonly uri: URI } | null;
	getSelection(): { getStartPosition(): { readonly lineNumber: number; readonly column: number } } | null;
	getPosition(): { readonly lineNumber: number; readonly column: number } | null;
}

export async function openActiveReviewSourceInVsCode(input: {
	readonly connection: ReviewServerConnection;
	readonly profile: ReviewServerConnectionProfile;
	readonly editor: ReviewExternalSourceEditor | null;
	readonly processAdapter: ReviewExternalSourceProcessAdapter;
}): Promise<ReviewExternalSourceOpenResult> {
	const resource = input.editor?.getModel()?.uri;
	const position = input.editor?.getSelection()?.getStartPosition() ?? input.editor?.getPosition();
	if (!resource || !position) throw new Error("Focus an API Source Editor before opening VS Code.");
	return openReviewSourceInVsCode({ ...input, resource, position });
}

async function openReviewSourceInVsCode(input: {
	readonly connection: ReviewServerConnection;
	readonly profile: ReviewServerConnectionProfile;
	readonly resource: URI;
	readonly position: { readonly lineNumber: number; readonly column: number };
	readonly processAdapter: ReviewExternalSourceProcessAdapter;
}): Promise<ReviewExternalSourceOpenResult> {
	if (input.connection.sourceAccessMode !== "api-only") {
		throw new Error("Open in VS Code is available for API-only Review Server connections.");
	}
	if (input.resource.scheme !== REVIEW_API_SOURCE_SCHEME) {
		throw new Error("Open in VS Code requires an API Source Editor.");
	}
	const configuration = input.profile.externalSourceOpener;
	if (!configuration) {
		throw new Error("Configure a VS Code CLI executable and Remote-SSH authority for this Review Server Connection Profile.");
	}
	const destination = await resolveReviewSourceDestination(input.connection, input.resource, true);
	return input.processAdapter.open({
		executable: configuration.executable,
		authority: configuration.authority,
		filePath: destination.filePath,
		lineNumber: input.position.lineNumber,
		column: input.position.column,
	});
}
