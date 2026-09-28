# TrueNAS Headless Deployment

This deployment runs the fork's headless Review Server on the TrueNAS Docker engine and exposes it only on the existing `devnet` network. It does not publish a host or LAN port.

## Start or update

From the repository root:

```bash
deploy/whiteboard-headless/start.sh
```

The wrapper:

1. prompts for the stable Review Server bearer token when it is not already present as `WHITEBOARD_REVIEW_SERVER_TOKEN`;
2. writes the token with mode `0600` to the TrueNAS-backed state directory;
3. builds and packs `@dev.fast/review` from the current checkout;
4. mounts the host token file into the container as `/run/secrets/review_server_token`;
5. waits for the authenticated health check to pass; and
6. removes the temporary package artifact and its shell copy of the token.

The token is absent from argv, Compose YAML, the image, and the container environment. It is intentionally persisted on the TrueNAS host so the service can restart unattended. Running `docker compose up` before `start.sh` initializes the token file fails during deployment, and the server refuses an absent or empty mounted token.

The container has `restart: unless-stopped`, so Docker restarts the existing container—including its secret mount—when the TrueNAS Docker engine restarts. A rebuild or interactive token prompt is not needed for an ordinary host restart.

## Install the devbox agent client

Pi sessions run on devbox, outside the server container. Install the fork-built CLI and the repository-owned Pi skill package with:

```bash
deploy/whiteboard-headless/install-agent-client.sh
```

The installer:

1. builds `@dev.fast/review` from this checkout;
2. links `whiteboard` and `review` into `~/.pi/agent/bin`, which is on Pi's `PATH`;
3. configures those wrappers to use `/home/dev/workspace/.service-data/whiteboard` unless `DEV_REVIEW_SERVER_DIR` is already set; and
4. installs the local `@dev.fast/pi-whiteboard` package through `pi install` without copying its skill into another repository.

Existing Pi sessions must run `/reload` after installation. Verify from any devbox directory:

```bash
whiteboard server status
whiteboard api session_get_instructions '{}'
pi list
```

The CLI reads the server URL and bearer token from the protected discovery record in the configured state directory. Agents do not need the token in their environment.

## Persistent state

The server uses:

```text
Container/devbox: /home/dev/workspace/.service-data/whiteboard
TrueNAS host:     /mnt/ServiceAndDataPool/projects/.service-data/whiteboard
```

The whole projects dataset is mounted at the same absolute devbox path so API-only source navigation can resolve repository paths recorded by devbox authoring clients.

Back up or snapshot the TrueNAS `ServiceAndDataPool/projects` dataset. The state directory includes the Review database, discovery record, and mode-`0600` Compose token source; backups must be protected accordingly.

## Mac transport and Desktop profile

Start the tunnel on the Mac:

```bash
ssh -N -L 34125:whiteboard:34125 truenas-dev-2
```

Use the fork-built Whiteboard Desktop with an API-only server profile:

```text
URL:        http://127.0.0.1:34125
Token:      the same token supplied to start.sh
Source mode: API-only
```

Whiteboard does not create or supervise the SSH tunnel.

## Operations

Inspect health and logs:

```bash
cd deploy/whiteboard-headless
sudo docker compose ps
sudo docker compose logs --follow whiteboard

pnpm --dir ../.. --filter @dev.fast/review review \
  --state-dir /home/dev/workspace/.service-data/whiteboard \
  server status
```

Stop without deleting the container:

```bash
cd deploy/whiteboard-headless
sudo docker compose stop whiteboard
```

Restart after a deliberate stop by running `start.sh` again so the token is supplied explicitly.

Remove the container and network attachment without deleting persisted Review state:

```bash
cd deploy/whiteboard-headless
sudo docker compose down
```
