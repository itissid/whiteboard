/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewDesktopChannel } from "./reviewDesktopChannel.js";

test("selecting a remote profile stops the embedded server without requesting its connection", async () => {
  let embeddedConnectionRequests = 0;
  let remoteActivations = 0;
  const host = {
    appSessionId: "app-session",
    requestEmbeddedConnection() {
      embeddedConnectionRequests += 1;
      throw new Error("The embedded server must not start for a remote profile.");
    },
    activateRemoteProfile() {
      remoteActivations += 1;
      return Promise.resolve();
    },
  };
  const channel = new ReviewDesktopChannel(host as never);

  assert.equal(await channel.call("test", "getAppSessionId"), "app-session");
  await channel.call("test", "activateRemoteProfile");

  assert.equal(remoteActivations, 1);
  assert.equal(embeddedConnectionRequests, 0);
});

test("the default connection starts through the embedded server host", async () => {
  const connection = { url: "http://127.0.0.1:5000" };
  let requests = 0;
  const channel = new ReviewDesktopChannel({
    appSessionId: "app-session",
    requestEmbeddedConnection() {
      requests += 1;
      return Promise.resolve(connection);
    },
    activateRemoteProfile() {
      return Promise.resolve();
    },
  } as never);

  assert.strictEqual(await channel.call("test", "getConnection"), connection);
  assert.equal(requests, 1);
});
