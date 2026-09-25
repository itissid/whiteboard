/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import {
  editActiveRemoteProfileFromPrompts,
  editRemoteProfileFromPicker,
  removeRemoteProfileFromPicker,
  switchRemoteProfileFromPicker,
  createRemoteProfileFromPrompts,
} from "./reviewServerProfile.contribution.js";

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

test("the profile picker explicitly switches the selected Review store", async () => {
  const profiles = [
    { id: "development", name: "Development", serverUrl: "http://127.0.0.1:5500", sourceAccessMode: "api-only" },
    { id: "staging", name: "Staging", serverUrl: "http://127.0.0.1:5600", sourceAccessMode: "api-only" },
  ] as const;
  let pickedItems: readonly { id: string; label: string; description?: string }[] = [];
  let switched: string | undefined;
  let reloads = 0;

  await switchRemoteProfileFromPicker(
    {
      pick(items: readonly { id: string; label: string; description?: string }[]) {
        pickedItems = items;
        return Promise.resolve(items[1]);
      },
    } as never,
    {
      getRemoteProfiles: () => ({ profiles, activeProfileId: "development" }),
      switchRemoteProfile: (id: string) => { switched = id; return Promise.resolve({ status: "connected" }); },
    } as never,
    { reload: () => { reloads += 1; return Promise.resolve(); } } as never,
  );

  assert.deepEqual(pickedItems.map(item => ({ label: item.label, description: item.description })), [
    { label: "Development", description: "Active · http://127.0.0.1:5500" },
    { label: "Staging", description: "http://127.0.0.1:5600" },
  ]);
  assert.equal(switched, "staging");
  assert.equal(reloads, 1);
});

test("editing credentials keeps the active profile identifier and hides the token prompt", async () => {
  const profile = { id: "development", name: "Development", serverUrl: "http://127.0.0.1:5500", sourceAccessMode: "api-only" } as const;
  const answers = ["Development renamed", "http://127.0.0.1:5700", "replacement-token"];
  const prompts: Array<Record<string, unknown>> = [];
  let edited: { id: string; input: unknown } | undefined;
  let reloads = 0;

  await editActiveRemoteProfileFromPrompts(
    {
      input(options: Record<string, unknown>) {
        prompts.push(options);
        return Promise.resolve(answers.shift());
      },
    } as never,
    {
      getRemoteProfiles: () => ({ profiles: [profile], activeProfileId: profile.id }),
      editRemoteProfile: (id: string, input: unknown) => {
        edited = { id, input };
        return Promise.resolve({ status: "connected" });
      },
    } as never,
    { reload: () => { reloads += 1; return Promise.resolve(); } } as never,
  );

  assert.deepEqual(edited, {
    id: profile.id,
    input: { name: "Development renamed", serverUrl: "http://127.0.0.1:5700", token: "replacement-token" },
  });
  assert.equal(prompts[0]?.value, profile.name);
  assert.equal(prompts[1]?.value, profile.serverUrl);
  assert.equal(prompts[2]?.password, true);
  assert.equal("value" in prompts[2]!, false);
  assert.equal(reloads, 1);
});

test("the edit picker updates an inactive profile without changing the active Review store", async () => {
  const profiles = [
    { id: "development", name: "Development", serverUrl: "http://127.0.0.1:5500", sourceAccessMode: "api-only" },
    { id: "staging", name: "Staging", serverUrl: "http://127.0.0.1:5600", sourceAccessMode: "api-only" },
  ] as const;
  const answers = ["Staging renamed", "http://127.0.0.1:5800", ""];
  let edited: { id: string; input: unknown } | undefined;
  let reloads = 0;

  await editRemoteProfileFromPicker(
    {
      pick: (items: readonly { id: string }[]) => Promise.resolve(items[1]),
      input: () => Promise.resolve(answers.shift()),
    } as never,
    {
      getRemoteProfiles: () => ({ profiles, activeProfileId: "development" }),
      editRemoteProfile: (id: string, input: unknown) => { edited = { id, input }; return Promise.resolve({ status: "connected" }); },
    } as never,
    { reload: () => { reloads += 1; return Promise.resolve(); } } as never,
  );

  assert.deepEqual(edited, {
    id: "staging",
    input: { name: "Staging renamed", serverUrl: "http://127.0.0.1:5800" },
  });
  assert.equal(reloads, 0);
});

test("the remove picker can delete an inactive profile without changing the active Review store", async () => {
  const profiles = [
    { id: "development", name: "Development", serverUrl: "http://127.0.0.1:5500", sourceAccessMode: "api-only" },
    { id: "staging", name: "Staging", serverUrl: "http://127.0.0.1:5600", sourceAccessMode: "api-only" },
  ] as const;
  let removed: string | undefined;
  let reloads = 0;

  await removeRemoteProfileFromPicker(
    { pick: (items: readonly { id: string }[]) => Promise.resolve(items[1]) } as never,
    {
      getRemoteProfiles: () => ({ profiles, activeProfileId: "development" }),
      removeRemoteProfile: (id: string) => { removed = id; return Promise.resolve({ status: "connected" }); },
    } as never,
    { reload: () => { reloads += 1; return Promise.resolve(); } } as never,
  );

  assert.equal(removed, "staging");
  assert.equal(reloads, 0);
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
