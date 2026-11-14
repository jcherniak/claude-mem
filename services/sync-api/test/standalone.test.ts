import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceCommand } from "../src/admin";
import { defaultAuthDependencies } from "../src/auth";
import { DeviceTokens, tokenDigest } from "../src/device-tokens";
import { loadEnv } from "../src/env";
import { startSyncApi, DEFAULT_SYNC_API_TIMEOUTS, type SyncApiApp } from "../src/index";
import { authHeaders, DEFAULT_DATABASE_URL, observationOp, uniqueUser } from "./helpers";

const apps: SyncApiApp[] = [];
afterAll(async () => { for (const app of apps) await app.stop(); });

async function standalone() {
	const env = loadEnv({ DATABASE_URL: DEFAULT_DATABASE_URL, HOST: "127.0.0.1", PORT: "0",
		SYNC_AUTH_MODE: "local", SYNC_PROJECTION_MODE: "log", SYNC_DB_POOL_SIZE: "4", SYNC_USER_ID: uniqueUser(),
		SYNC_PUBLIC_URL: "https://sync.test", TOKEN_VERIFY_URL: "http://127.0.0.1:1/verify", INTERNAL_PROJECTOR_URL: "http://127.0.0.1:1/project" });
	let verifications = 0;
	const app = await startSyncApi(env, DEFAULT_SYNC_API_TIMEOUTS, {
		...defaultAuthDependencies(env), async verifyToken() { verifications++; throw new Error("External authentication must not run"); },
	});
	apps.push(app);
	const devices = new DeviceTokens(app.sql);
	const first = await devices.add(env.SYNC_USER_ID, "Computer A", "dev-a");
	const second = await devices.add(env.SYNC_USER_ID, "Computer B", "dev-b");
	const headers = authHeaders(first.userId, first.deviceId, first.token);
	const push = (ops: Awaited<ReturnType<typeof observationOp>>[]) => fetch(`${app.url}/v1/sync/ops`, {
		method: "POST", headers, body: JSON.stringify({ protocol_version: 2, ops }),
	});
	return { app, devices, first, second, headers, push, verifications: () => verifications };
}

describe("standalone deployment", () => {
	it("keeps hosted defaults and rejects invalid configuration", () => {
		const env = loadEnv({ DATABASE_URL: DEFAULT_DATABASE_URL });
		expect(env.SYNC_AUTH_MODE).toBe("cmem");
		expect(env.SYNC_PROJECTION_MODE).toBe("external");
		expect(env.SYNC_DB_POOL_SIZE).toBe(10);
		expect(() => loadEnv({ DATABASE_URL: DEFAULT_DATABASE_URL, SYNC_AUTH_MODE: "none" })).toThrow();
		expect(() => loadEnv({ DATABASE_URL: DEFAULT_DATABASE_URL, SYNC_PROJECTION_MODE: "skip" })).toThrow();
		for (const value of ["0", "-1", "4.5", "101", "four"]) expect(() => loadEnv({ DATABASE_URL: DEFAULT_DATABASE_URL, SYNC_DB_POOL_SIZE: value })).toThrow();
		expect(() => loadEnv({ FORWARD_ORIGIN: "https://proxy.test", SYNC_AUTH_MODE: "local" })).toThrow();
	});

	it("loads a password file without placing the password in Compose environment", () => {
		const directory = mkdtempSync(join(tmpdir(), "sync-password-"));
		try {
			const path = join(directory, "password");
			writeFileSync(path, "test:p@ssword\n", { mode: 0o600 });
			const env = loadEnv({ DATABASE_URL: "postgres://user@localhost/db", DATABASE_PASSWORD_FILE: path });
			expect(decodeURIComponent(new URL(env.DATABASE_URL).password)).toBe("test:p@ssword");
			expect(() => loadEnv({ DATABASE_URL: "postgres://user:existing@localhost/db", DATABASE_PASSWORD_FILE: path })).toThrow();
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});

	it("stores only digests, binds account/device, and honors revocation immediately", async () => {
		const { app, devices, first, headers } = await standalone();
		const [stored] = await app.sql`SELECT token_hash FROM sync_device_tokens WHERE user_id = ${first.userId} AND device_id = ${first.deviceId}`;
		expect(stored.token_hash).toBe(tokenDigest(first.token));
		expect(stored.token_hash).not.toContain(first.token);
		expect(JSON.stringify(await devices.list(first.userId))).not.toContain(stored.token_hash);
		const status = () => fetch(`${app.url}/v1/sync/status`, { headers });
		expect((await status()).status).toBe(200);
		for (const invalid of [{ ...headers, "X-User-Id": "another-account" }, { ...headers, "X-Device-Id": "dev-b" }, { ...headers, Authorization: "Bearer invalid" }]) {
			expect((await fetch(`${app.url}/v1/sync/status`, { headers: invalid })).status).toBe(401);
		}
		await expect(devices.add(first.userId, "Duplicate", first.deviceId)).rejects.toThrow("revoke");
		expect(await devices.revoke(first.userId, first.deviceId)).toBe(true);
		expect((await status()).status).toBe(401);
		const rotated = await devices.add(first.userId, "Reconnected", first.deviceId);
		expect(rotated.token).not.toBe(first.token);
		expect((await status()).status).toBe(401);
	});

	it("commits, deduplicates and pulls concurrent uploads without external services", async () => {
		const { app, first, second, headers, push, verifications } = await standalone();
		const op = await observationOp("1");
		const uploads = await Promise.all([push([op]), push([op])]);
		for (const response of uploads) {
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ head_seq: "1", projected_seq: "1" });
		}
		const pull = await fetch(`${app.url}/v1/sync/changes?since=0`, { headers: authHeaders(second.userId, second.deviceId, second.token) });
		const page = await pull.json() as { ops: Array<{ body: string }>; head_seq: string };
		expect(page.ops.map(value => value.body)).toEqual([op.body]);
		expect(page.head_seq).toBe("1");
		expect((await push([await observationOp("1", "2")])).status).toBe(200);
		expect((await push([await observationOp("2"), op])).status).toBe(400);
		const [row] = await app.sql`SELECT head_seq, projected_seq FROM sync_users WHERE user_id = ${first.userId}`;
		expect(row).toMatchObject({ head_seq: "2", projected_seq: "2" });
		for (const path of ["/internal/v1/sync/reset", "/internal/v1/projection/drain", "/v1/sync/ws"]) {
			expect((await fetch(`${app.url}${path}`, { headers })).status).toBe(404);
		}
		expect(verifications()).toBe(0);
	});

	it("retains the log and tokens after restarting the application", async () => {
		const { app, first, push } = await standalone();
		expect((await push([await observationOp("8")])).status).toBe(200);
		await app.stop();
		apps.splice(apps.indexOf(app), 1);
		const restarted = await startSyncApi(app.env);
		apps.push(restarted);
		const response = await fetch(`${restarted.url}/v1/sync/changes?since=0`, { headers: authHeaders(first.userId, first.deviceId, first.token) });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ head_seq: "1" });
	});

	it("prints existing-identity client settings only at issuance", async () => {
		const { app, first } = await standalone();
		const added = await deviceCommand(["device", "add", "Existing laptop", "--device-id", "preserved-device-id"], app.env, app.sql) as { settings: Record<string, string> };
		expect(added.settings).toMatchObject({ CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: "preserved-device-id", CLAUDE_MEM_CLOUD_SYNC_HUB_URL: "https://sync.test", CLAUDE_MEM_CLOUD_SYNC_WS: "false" });
		const listed = await deviceCommand(["device", "list"], app.env, app.sql);
		expect(JSON.stringify(listed)).not.toContain(added.settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN);
		expect(JSON.stringify(listed)).not.toContain("token_hash");
		expect(await deviceCommand(["device", "revoke", first.deviceId], app.env, app.sql)).toMatchObject({ revoked: true });
		await expect(deviceCommand(["device", "add", "Invalid", "extra"], app.env, app.sql)).rejects.toThrow("Usage");
		await expect(deviceCommand(["device", "add", "Wrong mode"], { ...app.env, SYNC_AUTH_MODE: "cmem" }, app.sql)).rejects.toThrow();
	});

	it("refuses to reuse an account log under a different projection mode", async () => {
		const { app, first, push } = await standalone();
		await app.store.getStatus(first.userId);
		await app.sql`UPDATE sync_users SET projection_mode = 'external' WHERE user_id = ${first.userId}`;
		const response = await push([await observationOp("9")]);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining("projection_mode_mismatch") });
	});
});
