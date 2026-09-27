# Remote Review Source Navigation

- Status: Accepted
- Date: 2026-09-24

## Context

Whiteboard Desktop currently assumes that its Review Server shares the desktop filesystem. Opening a `review-api-source://` resource is intercepted, `/navigator` prepares a pinned Git worktree, and the server's returned `workspacePath` and `filePath` are converted into local `file://` URIs.

A target deployment runs the Review Server, repository, and Pi on Linux while Whiteboard Desktop runs on a Mac connected through an externally managed SSH or Tailscale transport. The server URL alone cannot establish filesystem locality because an SSH-forwarded remote server also appears to be loopback.

Whiteboard already has API-backed source models, `/tree`, `/file`, and `/diff` endpoints, and read-only source/diff rendering. Microsoft VS Code with Remote-SSH remains the full remote IDE.

## Decision

Design this as an upstreamable, deployment-neutral Whiteboard capability rather than a private Mac/devbox patch.

Implement the smallest complete remote-review slice:

1. Whiteboard Desktop supports multiple named Review Server Connection Profiles with one active connection. A command/UI creates profiles containing URL and explicit Source Access Mode, stores metadata in settings, and stores each Review Server Token in OS-backed secret storage.
2. When the active profile is unavailable or rejects its token, Desktop remains on that profile and shows disconnected, retry, edit-credentials, and switch-profile controls. It never silently starts or falls back to a different local Review Server.
3. A remote Review Server accepts a stable configured bearer token so a saved Connection Profile survives server restarts; token rotation is explicit.
4. Whiteboard does not create or supervise SSH or Tailscale transport.
5. Shared-filesystem connections preserve the current `/navigator` Native Source Workspace behavior.
6. API-only connections bypass native-path interception and open pinned base/head source as immutable API Source Editors.
7. API Source Editors support full-file viewing, syntax highlighting, line reveal, copying, multiple tabs, and API-backed diffs.
8. Source editing, source-line review threads, live working-tree views, remote language services, project search, terminals, and debugging are outside this change.
9. An explicit Open in VS Code action hands a Linux pinned-worktree path and line to an existing Microsoft VS Code Remote-SSH authority.
10. The external VS Code handoff must pass a Mac learning test using the same underlying `code --remote ... --goto ...` command before implementation commits to that integration.

Ordinary Review document comments remain available through the remote Review Server. Pi remains an external process launched by a human or separate automation; automatic agent launch from a board comment is outside this change.

## Consequences

- Local source navigation and its richer workspace capabilities remain unchanged.
- Remote reviewers gain the full board plus read-only full-file and diff inspection without synchronizing the repository to the Mac.
- External VS Code provides editing, search, language services, terminals, tests, and debugging.
- Connection configuration must represent filesystem capability explicitly rather than infer it from hostname.
- The implementation must support and test two source-opening paths.
- True source-line comments require a separate domain and persistence design.

## Technical Validation

### 2026-09-25 — Mac Remote-SSH source handoff

A Mac learning test validated the external-editor premise in decision 10. From the installed Whiteboard process environment, `code --remote ssh-remote+truenas-dev-2 --goto <linux-path>:<line>:<column>` opened the intended Linux source location through the existing Remote-SSH authority. Evidence: `thoughts/itissid/handoffs/whiteboard-mac-vscode-remote-handoff-result.md`.

### 2026-09-27 — Dockerized headless-server CLI authentication

A devbox learning test built commit `9a0fe2d0` into a Node 24 container, started the headless Review Server with a stable configured token and shared state directory, and exercised the real CLI from devbox. `server status`, `api tools`, and a non-mutating `api session_capabilities` call succeeded through persisted `review-server/server.json` discovery. An MCP SDK client then initialized `whiteboard mcp`, listed the same 28-tool catalog, and called `session_capabilities` successfully. Replacing only the discovery token with an invalid value caused the API call to fail; restoring it restored success.

This validates the server-side persisted-token interoperability assumed by decision 3. It does not replace Desktop's OS-backed profile secret storage and does not yet validate Mac GUI connectivity through the transport. Full setup, commands, outputs, negative control, limitations, and cleanup are recorded in `thoughts/shared/research/2026-09-27-dockerized-headless-server-cli-auth-learning-test.md`.

### 2026-09-27 — TrueNAS Compose deployment

A production-shaped Compose service validated the container-specific seams that the earlier disposable test did not cover. The server bound `0.0.0.0:34125`, advertised `http://whiteboard:34125` on `devnet`, read its stable token from a mode-`0600` TrueNAS-backed file mounted read-only at `/run/secrets`, and published no host/LAN port. Devbox `server status`, JSON API, MCP initialization/tool calls, and Desktop-origin CORS preflight all passed through the advertised origin.

The deployed container is healthy with `restart: unless-stopped`. A direct Docker restart, without rerunning the wrapper or resupplying the token, preserved authenticated health and devbox API access. Docker inspection verifies the host-restart policy, but the TrueNAS host itself was not rebooted. Full topology, positive and red results, persistence details, and remaining Mac GUI validation are recorded in `thoughts/shared/research/2026-09-27-truenas-compose-headless-deployment-validation.md`.
