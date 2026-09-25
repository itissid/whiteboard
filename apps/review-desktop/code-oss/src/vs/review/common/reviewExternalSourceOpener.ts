/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ReviewExternalSourceOpenerConfiguration {
	readonly executable: string;
	readonly authority: string;
}

export interface ReviewExternalSourceOpenRequest {
	readonly executable: string;
	readonly authority: string;
	readonly filePath: string;
	readonly lineNumber: number;
	readonly column: number;
}

export interface ReviewExternalSourceOpenResult {
	readonly status: "accepted";
}

export function parseReviewExternalSourceOpenerConfiguration(
	value: unknown,
): ReviewExternalSourceOpenerConfiguration {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("The external source opener configuration is invalid.");
	}
	const configuration = value as Record<string, unknown>;
	if (
		typeof configuration.executable !== "string" ||
		!configuration.executable.trim() ||
		typeof configuration.authority !== "string" ||
		!configuration.authority.trim()
	) {
		throw new Error("The external source opener configuration is invalid.");
	}
	return {
		executable: configuration.executable.trim(),
		authority: configuration.authority.trim(),
	};
}

export function parseReviewExternalSourceOpenRequest(
	value: unknown,
): ReviewExternalSourceOpenRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("The external source-open request is invalid.");
	}
	const request = value as Record<string, unknown>;
	if (
		typeof request.executable !== "string" ||
		!request.executable ||
		typeof request.authority !== "string" ||
		!request.authority ||
		typeof request.filePath !== "string" ||
		!request.filePath ||
		!Number.isInteger(request.lineNumber) ||
		(request.lineNumber as number) < 1 ||
		!Number.isInteger(request.column) ||
		(request.column as number) < 1
	) {
		throw new Error("The external source-open request is invalid.");
	}
	return request as unknown as ReviewExternalSourceOpenRequest;
}
