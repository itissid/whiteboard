# Build and install Whiteboard on macOS with a remote Review Server

This workflow installs the Whiteboard GUI in `/Applications` and keeps the persistent Review Server on devbox. A per-user macOS LaunchAgent maintains the SSH tunnel:

```text
/Applications/Whiteboard.app
        |
        | http://127.0.0.1:34125
        v
LaunchAgent + autossh on the Mac
        |
        | SSH through truenas-dev-2
        v
Docker DNS whiteboard:34125 on devnet
```

The Docker service does not publish a TrueNAS or LAN port. The Mac listener binds only to `127.0.0.1`.

When the saved `TrueNAS Devbox` profile is active, Whiteboard loads it before requesting an embedded connection. The embedded Mac Review Server therefore does not start. If the remote endpoint is unavailable, Whiteboard shows a disconnected state instead of silently falling back to local review state.

## Prerequisites

The tested installation requires:

- an Apple Silicon Mac;
- the repository at `~/workspace/whiteboard`;
- Node.js 24 and the repository's pnpm version (`11.1.2`);
- Xcode command-line tools, including `codesign`;
- [`autossh`](https://www.harding.motd.ca/autossh/), installed with `brew install autossh`;
- a working SSH alias named `truenas-dev-2`; and
- the remote Docker service described in [the headless deployment guide](../deploy/whiteboard-headless/DEPLOYMENT.md).

The Make workflow finds Node 24 under a normal NVM installation even when the caller's current shell selects another Node version. Set `WHITEBOARD_NODE24_BIN` to the appropriate `bin` directory if Node 24 is installed elsewhere.

## Build and install

From the repository root:

```bash
cd ~/workspace/whiteboard
git pull
make install
```

`make install` performs four ordered operations:

1. installs the locked pnpm dependencies;
2. builds a self-contained arm64 `Whiteboard.app` and applies a recursive local ad-hoc signature;
3. safely replaces `/Applications/Whiteboard.app`; and
4. installs and starts `~/Library/LaunchAgents/dev.fast.review-tunnel.plist`.

The LaunchAgent forwards:

```text
127.0.0.1:34125 → truenas-dev-2 → whiteboard:34125
```

It uses `autossh`, `ExitOnForwardFailure`, SSH keepalives, `RunAtLoad`, and launchd `KeepAlive`.

## First launch and profile setup

Open the installed application:

```bash
make open-app
```

A locally rebuilt, ad-hoc-signed application may trigger a macOS Keychain dialog for **Whiteboard Safe Storage**. Enter the Mac login password in that native dialog and select **Always Allow**. This grants the rebuilt application access to Whiteboard's encrypted profile credentials; it is not asking for the Review Server token.

Copy the remote Review Server token without printing it:

```bash
make copy-token
```

Then configure Whiteboard:

1. Press **F1**.
2. Run **Whiteboard: Add Review Server Profile...**
3. Enter the following values:

| Prompt | Value |
|---|---|
| Name | `TrueNAS Devbox` |
| Review Server URL | `http://127.0.0.1:34125` |
| Token | Paste from the clipboard |
| VS Code CLI | `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` |
| Remote-SSH authority | `truenas-dev-2` |

After the profile reloads, Whiteboard stores the token in macOS secret storage. Subsequent launches select the saved remote profile automatically and do not start the embedded Review Server.

On a completely fresh profile, Whiteboard may briefly start its embedded server before the remote profile is created. Selecting the remote profile stops that server and removes its discovery file. It does not restart on later cold launches while the remote profile remains active.

The current API-only server can show a non-blocking local CLI installation warning because it does not expose the Desktop install-status endpoint. This does not indicate a tunnel or profile failure.

## Make targets

Run all targets from `~/workspace/whiteboard`.

| Target | Effect |
|---|---|
| `make build-app` | Build and locally sign the self-contained application bundle. |
| `make install-app` | Safely copy the existing build to `/Applications/Whiteboard.app`. |
| `make uninstall-app` | Quit and remove the installed application. |
| `make open-app` | Open the installed application. |
| `make install-tunnel` | Generate, install, and start the autossh LaunchAgent. |
| `make start-tunnel` | Bootstrap or restart the installed LaunchAgent. |
| `make stop-tunnel` | Boot out the LaunchAgent and free local port 34125. |
| `make restart-tunnel` | Restart the LaunchAgent and wait for the server boundary. |
| `make status-tunnel` | Report launchd, listener, and HTTP boundary status. |
| `make copy-token` | Copy the remote token directly to the macOS clipboard. |
| `make verify` | Verify the bundle signature, LaunchAgent, listener, and server reachability. |
| `make install` | Build/install the app, install the tunnel, and verify both. |
| `make uninstall` | Remove the LaunchAgent and application bundle. |

The tunnel can be customized at invocation time:

```bash
make install-tunnel \
  SSH_HOST=truenas-dev-2 \
  LOCAL_PORT=34125 \
  REMOTE_HOST=whiteboard \
  REMOTE_PORT=34125
```

## Verify the installation

Run:

```bash
make verify
```

A healthy installation reports:

```text
LaunchAgent loaded: yes
Local listener: yes
Unauthenticated health status: 401
Application: /Applications/Whiteboard.app
Bundle identifier: dev.fast.review
Tunnel endpoint: http://127.0.0.1:34125
Whiteboard installation verification passed.
```

The unauthenticated `401` is intentional: it proves that the tunnel reaches the Review Server authentication boundary without putting the token in the plist or process arguments.

LaunchAgent logs are stored at:

```text
~/Library/Logs/Whiteboard/tunnel.stdout.log
~/Library/Logs/Whiteboard/tunnel.stderr.log
```

Inspect launchd directly with:

```bash
launchctl print "gui/$(id -u)/dev.fast.review-tunnel"
```

## Rebuild and upgrade

Pull and reinstall:

```bash
cd ~/workspace/whiteboard
git pull
make install
```

The install preserves Whiteboard's user data and Keychain items. Because each local ad-hoc build has a new code signature, macOS may ask for access to **Whiteboard Safe Storage** again. Select **Always Allow**. The saved Review Server token should then become available without re-entering it.

## Uninstall

```bash
cd ~/workspace/whiteboard
make uninstall
```

This removes `/Applications/Whiteboard.app` and the tunnel LaunchAgent. It intentionally preserves Whiteboard's user settings and Keychain credentials so reinstalling does not destroy the configured profile.

## Learning-test results

The workflow was verified on the target Mac against the live `whiteboard:34125` Docker service:

- the complete arm64 package build passed strict recursive signature verification;
- `/Applications/Whiteboard.app` launched without checkout-dependent arguments;
- LaunchAgent install, stop, start, restart, status, and uninstall all behaved as documented;
- full `make uninstall` followed by `make install` completed successfully;
- the saved remote profile attached through the automatic tunnel;
- no embedded discovery server appeared during normal remote-profile cold starts;
- the installed process had no debugging port; and
- replacing the ad-hoc-signed app produced the documented Keychain approval prompt, after which remote attachment succeeded.
