import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../services/sync-api/src/env';
import { startSyncApi } from '../services/sync-api/src/index';
import { DeviceTokens } from '../services/sync-api/src/device-tokens';
import { SessionStore } from '../src/services/sqlite/SessionStore';
import { CloudSync } from '../src/services/sync/CloudSync';
import { SyncApply } from '../src/services/sync/SyncApply';
import { SyncClient } from '../src/services/sync/SyncClient';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must identify an isolated loopback test database');
const parsed = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
  throw new Error('Smoke test refuses non-loopback or non-test PostgreSQL databases');
}

const env = loadEnv({ DATABASE_URL: databaseUrl, PORT: '0', HOST: '127.0.0.1',
  SYNC_AUTH_MODE: 'local', SYNC_PROJECTION_MODE: 'log', SYNC_DB_POOL_SIZE: '4',
  SYNC_USER_ID: `self-hosted-smoke-${crypto.randomUUID()}` });
let app = await startSyncApi(env);
env.PORT = app.server.port!;
const directory = mkdtempSync(join(tmpdir(), 'self-hosted-sync-'));
const devices: Array<Awaited<ReturnType<typeof openDevice>>> = [];

async function openDevice(name: string) {
  const credentials = await new DeviceTokens(app.sql).add(env.SYNC_USER_ID, name);
  const store = new SessionStore(join(directory, `${name}.db`));
  let online = true;
  const fetchImpl: typeof fetch = ((input, options) => {
    if (!online) return Promise.reject(new Error('Synthetic sync outage'));
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, '127.0.0.1');
    return fetch(input, options);
  }) as typeof fetch;
  const cloudSync = new CloudSync(store.db, {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: credentials.token,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: credentials.userId,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: app.url,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: credentials.deviceId,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: name,
  }, { fetchImpl, settingsPath: join(directory, `${name}-settings.json`), debounceMs: 60_000, backoffInitialMs: 50, backoffMaxMs: 100 });
  const apply = new SyncApply(store.db, { deviceId: credentials.deviceId });
  const client = new SyncClient(apply, {
    hubUrl: app.url, token: credentials.token, userId: credentials.userId, deviceId: credentials.deviceId,
    fetchImpl, wsEnabled: false, minPullGapMs: 0, activePollMs: 60_000, idlePollMs: 60_000,
  });
  client.start();
  return { credentials, store, cloudSync, apply, client, offline(value: boolean) { online = !value; } };
}

function save(device: typeof devices[number], title: string) {
  const contentId = crypto.randomUUID();
  const memoryId = crypto.randomUUID();
  const session = device.store.createSDKSession(contentId, 'self-hosted-smoke', 'Synthetic saved memory');
  device.store.updateMemorySessionId(session, memoryId);
  return device.store.storeObservation(memoryId, 'self-hosted-smoke', {
    type: 'discovery', title, subtitle: null, facts: [], narrative: 'Synthetic record; no inference provider is used.',
    concepts: [], files_read: [], files_modified: [],
  }, 1, 0).id;
}

function count(device: typeof devices[number], title: string): number {
  return (device.store.db.query('SELECT COUNT(*) AS count FROM observations WHERE title = ?').get(title) as { count: number }).count;
}

async function pull(device: typeof devices[number]) {
  const deadline = Date.now() + 10_000;
  const head = (await app.store.getStatus(env.SYNC_USER_ID)).head_seq;
  do {
    await device.client.pullOnce({ force: true, timeoutMs: 3_000 });
    if (device.apply.getCursor() === head) return;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error('Client failed to reach the standalone log head');
}

try {
  const first = await openDevice('first');
  devices.push(first);
  const second = await openDevice('second');
  devices.push(second);
  const firstId = save(first, 'SMOKE_FROM_FIRST');
  save(second, 'SMOKE_FROM_SECOND');
  await Promise.all(devices.map(device => device.cloudSync.flush()));
  await Promise.all(devices.map(pull));
  assert.equal(count(first, 'SMOKE_FROM_SECOND'), 1);
  assert.equal(count(second, 'SMOKE_FROM_FIRST'), 1);
  const before = (await app.store.getStatus(env.SYNC_USER_ID)).head_seq;
  await Promise.all(devices.map(device => device.cloudSync.flush()));
  assert.equal((await app.store.getStatus(env.SYNC_USER_ID)).head_seq, before);
  console.log('PASS bidirectional real-client sync, concurrent writes and duplicate-free retry');

  first.offline(true);
  save(first, 'SMOKE_OFFLINE');
  await first.cloudSync.flush();
  assert.equal(count(second, 'SMOKE_OFFLINE'), 0);
  first.offline(false);
  await Bun.sleep(150);
  await first.cloudSync.flush();
  await pull(second);
  assert.equal(count(second, 'SMOKE_OFFLINE'), 1);
  console.log('PASS outage retains only already-saved records and catches up without inference');

  first.cloudSync.queueDelete('observation', String(firstId));
  await first.cloudSync.flush();
  await pull(second);
  assert.equal(count(second, 'SMOKE_FROM_FIRST'), 0);
  console.log('PASS tombstone convergence');

  await app.stop();
  app = await startSyncApi(env);
  await pull(second);
  const state = await app.store.getStatus(env.SYNC_USER_ID);
  assert.equal(state.projected_seq, state.head_seq);
  assert.notEqual(state.head_seq, '0');
  await new DeviceTokens(app.sql).revoke(env.SYNC_USER_ID, first.credentials.deviceId);
  const rejected = await fetch(`${app.url}/v1/sync/status`, { headers: {
    Authorization: `Bearer ${first.credentials.token}`, 'X-User-Id': env.SYNC_USER_ID, 'X-Device-Id': first.credentials.deviceId,
  } });
  assert.equal(rejected.status, 401);
  console.log('PASS restart persistence, complete checkpoint and immediate token revocation');
} finally {
  for (const device of devices) {
    device.client.stop();
    await device.cloudSync.stop();
    device.store.close();
  }
  for (const table of ['sync_repair_receipts', 'sync_entity_heads', 'sync_ops', 'sync_devices', 'sync_device_tokens', 'sync_users']) {
    await app.sql.unsafe(`DELETE FROM ${table} WHERE user_id = $1`, [env.SYNC_USER_ID]);
  }
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
}
