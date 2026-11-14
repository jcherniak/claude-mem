# Self-hosted Claude-Mem sync

This service synchronizes already-saved Claude-Mem records between computers.
Each computer keeps its local SQLite database. The server keeps an ordered log
in PostgreSQL. It does not run inference or replay failed observer inputs.
The protocol and clients are unchanged. No CMEM subscription is required when
local device authentication is selected.

## Deploy

Run these commands on the server. Docker Compose builds the API there.

```bash
sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" /srv/claude-mem
git clone --branch feat/self-hosted-sync https://github.com/jcherniak/claude-mem.git /srv/claude-mem
cd /srv/claude-mem/services/sync-api
cp .env.compose.example .env
chmod 600 .env
install -d -m 700 secrets
(umask 077; openssl rand -hex 32 > secrets/postgres_password)
sudo chown 1001:1001 secrets/postgres_password
sudo chmod 0400 secrets/postgres_password
docker compose config --quiet
docker compose up -d --build --wait
```

Create the password file only on first installation. Do not overwrite it on an
update: PostgreSQL does not change an existing database password when this
file changes. UID/GID 1001 match the unprivileged API image. Compose mounts the
file directly, so its host permissions must allow that container user to read
it. The PostgreSQL entrypoint reads it as root before dropping privileges.

Set `SYNC_PUBLIC_URL` in `.env` to the HTTPS address clients will use. The
default is `https://justin-personal.badger-snapper.ts.net:8444`.
The API binds only to host loopback port 8099. PostgreSQL has no published port.
Do not place secrets in Git or send tokens through chat.

### Host-side Tailscale Serve

Use the host's existing Tailscale connection; no extra enrollment key or
Tailscale container is required.

```bash
tailscale serve status --json
sudo tailscale serve --bg --https=8444 http://127.0.0.1:8099
tailscale serve status --json
curl --fail https://justin-personal.badger-snapper.ts.net:8444/health
```

Check that port 8444 is unused before configuring it. Do not reset Serve or
replace existing routes. Do not enable Funnel for this port: the endpoint is
private to the tailnet. The host daemon keeps the background Serve setting
across restarts.

## Connect a computer

On an existing installation, first read its
`CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID` from `~/.claude-mem/settings.json`. Preserve
that value. Then create its token on the server:

```bash
docker compose exec sync-api bun run src/admin.ts device add laptop --device-id EXISTING_DEVICE_ID
```

For a new installation with no device ID, omit `--device-id`; the command
generates one. The command prints a JSON object. Merge its `settings` fields
into that computer's existing settings, preserving all other fields and any
outer `env` wrapper. Keep the settings file private (mode `0600` on Unix).
Then run `npx claude-mem restart` on the computer and check the local viewer's
sync status. The existing worker must be installed before this step.

The token is displayed only at creation. The database stores its SHA-256 hash,
not the usable token. Tokens have 256 random bits and are bound to the printed
account and device ID. Each authenticated HTTP request checks the database,
so revocation takes effect on the next request without a cached grace period.
An already-authenticated request may finish.

```bash
docker compose exec sync-api bun run src/admin.ts device list
docker compose exec sync-api bun run src/admin.ts device revoke DEVICE_ID
```

To replace a lost token, revoke it and issue another for the same device ID.
Listing devices never reveals tokens or hashes. Revoking a token does not
delete saved records or release the protocol's 64-device registration limit.

Moving from another sync server requires a separately reviewed migration.
Merely changing URLs does not migrate already-acknowledged rows. Preserve the
existing local database. Do not reset `synced_at`, device IDs, or cursors to
force uploads.

## Authentication and projection options

The API itself retains upstream defaults: `SYNC_AUTH_MODE=cmem` and
`SYNC_PROJECTION_MODE=external`. The Compose deployment explicitly selects
`local` and `log`. Invalid mode values fail startup; there is no fallback.

| Setting | Options | Meaning |
| --- | --- | --- |
| `SYNC_AUTH_MODE` | `cmem`, `local` | Existing CMEM account verification or database-backed device tokens. |
| `SYNC_PROJECTION_MODE` | `external`, `log` | Existing hosted projector or standalone synchronization log. |
| `SYNC_USER_ID` | Default `personal` | Account permitted by local authentication and used by device commands. |
| `SYNC_PUBLIC_URL` | HTTPS URL | Client destination printed by `device add`; loopback HTTP is allowed for tests. |
| `SYNC_DB_POOL_SIZE` | 1–100; Compose default 4 | Maximum API database connections. |

With `cmem`, configure `TOKEN_VERIFY_URL` (default
`https://cmem.ai/api/pro/sync/verify`). Clients use their CMEM token and account
ID. Device commands are available only with local authentication.

With `external`, configure `INTERNAL_PROJECTOR_URL` and
`CMEM_INTERNAL_PROJECTOR_SECRET`. This preserves the existing requirement that
projection finishes before acknowledging a push. Protect `.env` if it holds
that secret. With `log`, the log and entity heads are the complete server read
source; the checkpoint advances in the same transaction as the records.
No external authentication or projection service is called in `local`/`log`.

Projection mode is fixed per account log. Existing logs are classified as
external. Do not switch an existing account to another projection mode: writes
fail with `projection_mode_mismatch` rather than falsely confirming projection.
Use a separate database/account and an explicit migration if a switch is needed.
Local authentication or log mode disables hosted internal administration and
legacy WebSocket routes. Current clients use HTTP polling; set
`CLAUDE_MEM_CLOUD_SYNC_WS=false` as printed by the device command.
The existing forward-proxy mode is unchanged and cannot be combined with the
new local or log modes.

## PostgreSQL tuning and persistence

Change these values in `.env`, then recreate the containers with
`docker compose up -d --build --wait`.

| Compose variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_MEMORY_LIMIT` | `512m` | Container memory ceiling, not a measured usage guarantee. |
| `PG_SHARED_BUFFERS` | `64MB` | Shared database page buffers. |
| `PG_WORK_MEM` | `2MB` | Memory per sort/hash operation; concurrent operations add up. |
| `PG_MAINTENANCE_WORK_MEM` | `32MB` | Maintenance-operation memory. |
| `PG_AUTOVACUUM_WORK_MEM` | `16MB` | Memory per autovacuum worker. |
| `PG_EFFECTIVE_CACHE_SIZE` | `128MB` | Planner estimate; it does not allocate memory. |
| `PG_MAX_CONNECTIONS` | `20` | Database connection limit; leave room above the API pool for administration. |
| `PG_AUTOVACUUM_MAX_WORKERS` | `1` | Concurrent autovacuum workers. |
| `SYNC_MEMORY_LIMIT` | `256m` | API container memory ceiling. |

Parallel queries are disabled. Durability settings and autovacuum remain on.
Tune from actual `docker stats` measurements; reduce batch sizes or increase
memory if large imports exceed these initial limits.

PostgreSQL data lives in the Compose project's `postgres-data` named volume.
Restarting, rebuilding, or using `docker compose down` preserves it.
**Do not use `docker compose down --volumes` unless you intend to delete it.**
Logs rotate at 10 MB with three files per container.

## Update and troubleshoot

```bash
cd /srv/claude-mem
git pull --ff-only origin feat/self-hosted-sync
cd services/sync-api
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail=80 sync-api postgres
docker stats --no-stream
```

`/health` checks process liveness, not database readiness. An unauthenticated
`/v1/sync/status` request must return 401. Use the client's local sync status
for an authenticated end-to-end check. A 401 can indicate a revoked token or
mismatched account/device ID. A 503 indicates unavailable storage or projection;
check logs and configuration without resetting synchronization state.

This is record synchronization, not a copy of all local files. Image storage,
hosted viewer services, team administration, and automatic historical migration
are not included. Backup policy is managed separately.

## Verification

Run against an isolated loopback PostgreSQL database named with an `_test`
suffix, never the deployment database:

```bash
cd services/sync-api
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/sync_api_test bun test test
cd ../..
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/sync_api_test bun scripts/self-hosted-sync-smoke.ts
npm run typecheck
npm run build
```

The smoke test uses two real SQLite clients and a synthetic account. It checks
bidirectional concurrent writes, retry deduplication, offline saved-record
catch-up, deletions, restart persistence, and revocation without invoking an
inference provider.
