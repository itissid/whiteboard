/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from "node:child_process";
import { posix } from "node:path";

import {
	parseReviewExternalSourceOpenRequest,
	type ReviewExternalSourceOpenRequest,
	type ReviewExternalSourceOpenResult,
} from "../common/reviewExternalSourceOpener.js";

const STDERR_LIMIT = 16_384;

/**
 * Submits one source-open request to Microsoft VS Code. The fixed argv contract
 * is the one proven warm and cold on `prototype/mac-vscode-remote-handoff`; see
 * `thoughts/itissid/handoffs/whiteboard-mac-vscode-remote-handoff-result.md`.
 * A successful process exit means only that VS Code accepted the request;
 * Remote-SSH continues asynchronously and retains ownership of authentication
 * and trust prompts.
 */
export async function openInVsCodeRemoteSsh(
	input: ReviewExternalSourceOpenRequest,
): Promise<ReviewExternalSourceOpenResult> {
	const request = parseReviewExternalSourceOpenRequest(input);
	if (!posix.isAbsolute(request.filePath)) {
		throw new Error("Open in VS Code requires an absolute Linux path from the Review Server.");
	}
	const args = [
		"--reuse-window",
		"--remote",
		`ssh-remote+${request.authority}`,
		"--goto",
		`${request.filePath}:${request.lineNumber}:${request.column}`,
	];

	return new Promise((resolve, reject) => {
		const child = spawn(request.executable, args, {
			shell: false,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		child.stderr.on("data", chunk => {
			stderr = (stderr + String(chunk)).slice(-STDERR_LIMIT);
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				fail(new Error(`VS Code CLI executable was not found: ${request.executable}`));
				return;
			}
			fail(new Error(`Could not start the VS Code CLI: ${error.message}`));
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			const detail = stderr.trim();
			if (code !== 0) {
				fail(new Error(
					`VS Code CLI exited with status ${code === null ? `signal ${signal ?? "unknown"}` : code}${detail ? `: ${detail}` : "."}`,
				));
				return;
			}
			if (detail) {
				fail(new Error(`VS Code CLI reported an immediate handoff failure: ${detail}`));
				return;
			}
			settled = true;
			resolve({ status: "accepted" });
		});
	});
}
