/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteProfileFromPrompts } from "./reviewServerProfile.contribution.js";

test("the connection command collects a named API-only profile and reloads after activation", async () => {
  const answers = [
    "Forwarded devbox",
    "http://127.0.0.1:5500",
    "saved-token",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "development-host",
  ];
  const prompts: Array<Record<string, unknown>> = [];
  let activated: unknown;
  let reloads = 0;
  await createRemoteProfileFromPrompts(
    {
      input(options: Record<string, unknown>) {
        prompts.push(options);
        return Promise.resolve(answers.shift());
      },
    } as never,
    {
      createAndActivateRemoteProfile(input: unknown) {
        activated = input;
        return Promise.resolve();
      },
    } as never,
    { reload() { reloads += 1; return Promise.resolve(); } } as never,
  );

  assert.deepEqual(activated, {
    name: "Forwarded devbox",
    serverUrl: "http://127.0.0.1:5500",
    token: "saved-token",
    externalSourceOpener: {
      executable: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      authority: "development-host",
    },
  });
  assert.equal(prompts.length, 5);
  assert.equal(prompts[2]?.password, true);
  assert.equal(reloads, 1);
});

test("the connection command can leave the optional external source opener unconfigured", async () => {
  const answers = ["Review only", "http://127.0.0.1:5500", "saved-token", ""];
  let activated: unknown;
  await createRemoteProfileFromPrompts(
    { input: () => Promise.resolve(answers.shift()) } as never,
    { createAndActivateRemoteProfile: (input: unknown) => { activated = input; return Promise.resolve(); } } as never,
    { reload: () => Promise.resolve() } as never,
  );

  assert.deepEqual(activated, {
    name: "Review only",
    serverUrl: "http://127.0.0.1:5500",
    token: "saved-token",
  });
});

test("cancelling a connection prompt preserves the current connection", async () => {
  let activations = 0;
  let reloads = 0;
  await createRemoteProfileFromPrompts(
    { input: () => Promise.resolve(undefined) } as never,
    { createAndActivateRemoteProfile: () => { activations += 1; return Promise.resolve(); } } as never,
    { reload: () => { reloads += 1; return Promise.resolve(); } } as never,
  );
  assert.equal(activations, 0);
  assert.equal(reloads, 0);
});
