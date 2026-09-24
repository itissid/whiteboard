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
