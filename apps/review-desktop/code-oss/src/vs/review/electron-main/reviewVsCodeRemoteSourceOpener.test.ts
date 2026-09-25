/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openInVsCodeRemoteSsh } from "./reviewVsCodeRemoteSourceOpener.js";

async function makeFakeExecutable(
	root: string,
	body: string,
	mode = 0o755,
): Promise<string> {
	const executable = path.join(root, "fake code");
	await writeFile(executable, `#!${process.execPath}\n${body}`, { mode });
	return executable;
}

function request(executable: string) {
	return {
		executable,
		authority: "development-host",
		filePath: "/srv/reviews/worktree with spaces/src/example.ts",
		lineNumber: 42,
		column: 7,
	} as const;
}

test("the VS Code adapter passes the fixed Remote-SSH contract as an argv array", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "whiteboard-vscode-opener-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const recorded = path.join(root, "argv.json");
	const shellSentinel = path.join(root, "shell-expanded");
	const executable = await makeFakeExecutable(
		root,
		`require("node:fs").writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));`,
	);
	const input = {
		...request(executable),
		filePath: `/srv/reviews/worktree with spaces/$(touch ${shellSentinel})/example.ts`,
	};

	assert.deepEqual(await openInVsCodeRemoteSsh(input), { status: "accepted" });
	assert.deepEqual(JSON.parse(await readFile(recorded, "utf8")), [
		"--reuse-window",
		"--remote",
		"ssh-remote+development-host",
		"--goto",
		`${input.filePath}:42:7`,
	]);
	await assert.rejects(access(shellSentinel));
});

test("the VS Code adapter reports stderr even when the executable exits zero", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "whiteboard-vscode-opener-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const executable = await makeFakeExecutable(root, `process.stderr.write("Remote handoff rejected\\n");`);

	await assert.rejects(openInVsCodeRemoteSsh(request(executable)), /Remote handoff rejected/);
});

test("the VS Code adapter reports nonzero exits with their stderr", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "whiteboard-vscode-opener-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const executable = await makeFakeExecutable(
		root,
		`process.stderr.write("CLI refused the request\\n"); process.exitCode = 23;`,
	);

	await assert.rejects(openInVsCodeRemoteSsh(request(executable)), /status 23.*CLI refused the request/s);
});

test("the VS Code adapter distinguishes a missing executable from another spawn failure", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "whiteboard-vscode-opener-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await assert.rejects(
		openInVsCodeRemoteSsh(request(path.join(root, "missing-code"))),
		/VS Code CLI executable was not found/,
	);

	const notExecutable = await makeFakeExecutable(root, "", 0o644);
	await chmod(notExecutable, 0o644);
	await assert.rejects(
		openInVsCodeRemoteSsh(request(notExecutable)),
		/Could not start the VS Code CLI/,
	);
});

test("the VS Code adapter rejects a non-absolute Linux destination before launch", async () => {
	await assert.rejects(
		openInVsCodeRemoteSsh({ ...request("code"), filePath: "relative/example.ts" }),
		/absolute Linux path/,
	);
});
