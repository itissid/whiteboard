/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteProfileFromPrompts } from "./reviewServerProfile.contribution.js";

test("the connection command collects a named API-only profile and reloads after activation", async () => {
  const answers = ["Forwarded devbox", "http://127.0.0.1:5500", "saved-token"];
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
  });
  assert.equal(prompts.length, 3);
  assert.equal(prompts[2]?.password, true);
  assert.equal(reloads, 1);
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
