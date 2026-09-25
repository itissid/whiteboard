/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from "../../base/common/uri.js";
import { reviewSourceQuery, type ReviewSourceSelection } from "../common/reviewProtocol.js";
import { REVIEW_LANGUAGE_SOURCE_SCHEME } from "../common/reviewReadonlySource.js";
import { REVIEW_API_SOURCE_SCHEME, sourceLocation } from "../common/reviewSourceView.js";
import { reviewResponseError, type ReviewServerConnection } from "./reviewDesktopConnectionService.js";

export interface ReviewSourceNavigatorDestination {
	readonly workspacePath: string;
	readonly filePath: string;
}

interface ReviewSourceNavigatorQuery {
	readonly version?: number;
	readonly commit?: string;
	readonly repositoryId?: string;
	readonly base?: string;
	readonly head?: string;
	readonly side?: "base" | "head";
	readonly file?: string;
	readonly empty?: "true";
}

export async function requestReviewSourceNavigator(
	connection: ReviewServerConnection,
	reviewId: string,
	queryValues: ReviewSourceNavigatorQuery,
): Promise<{ workspacePath: string; filePath?: string }> {
	const query = new URLSearchParams(
		Object.entries(queryValues)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, String(value)]),
	);
	const response = await fetch(
		`${connection.serverUrl}/reviews-api/${encodeURIComponent(reviewId)}/navigator${query.size ? `?${query}` : ""}`,
		{
			method: "POST",
			headers: { "x-review-token": connection.token },
			signal: AbortSignal.timeout(60_000),
		},
	);
	if (!response.ok) throw await reviewResponseError(response, "Could not open the code navigator.");
	return response.json();
}

export async function resolveReviewSourceDestination(
	connection: ReviewServerConnection,
	resource: URI,
): Promise<ReviewSourceNavigatorDestination> {
	if (![REVIEW_API_SOURCE_SCHEME, REVIEW_LANGUAGE_SOURCE_SCHEME].includes(resource.scheme)) {
		throw new Error("Open in VS Code requires a pinned Review source.");
	}
	const target = sourceLocation(resource);
	const local = resource.scheme === REVIEW_LANGUAGE_SOURCE_SCHEME;
	const result = await requestReviewSourceNavigator(connection, target.view.reviewId, {
		...reviewSourceQuery(target.view),
		side: target.side,
		file: local ? undefined : target.file,
		empty: new URLSearchParams(resource.query).has("empty") ? "true" : undefined,
	});
	const filePath = local ? resource.fsPath : result.filePath;
	if (!filePath) throw new Error("The navigator did not resolve the source file.");
	return { workspacePath: result.workspacePath, filePath };
}

export async function resolveReviewSourceWorkspace(
	connection: ReviewServerConnection,
	selection: ReviewSourceSelection,
): Promise<{ workspacePath: string; filePath?: string }> {
	return requestReviewSourceNavigator(
		connection,
		selection.reviewId,
		selection.kind === "version" ? { version: selection.version } : {},
	);
}
