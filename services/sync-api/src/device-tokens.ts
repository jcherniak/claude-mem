import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { errorResponse, type AuthFail, type AuthOk } from "./auth";
import type { SyncApiEnv } from "./env";

export function tokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export class DeviceTokens {
	constructor(private readonly sql: postgres.Sql) {}

	async add(userId: string, name: string, deviceId: string = randomUUID()) {
		if (!name.trim() || name.length > 80) throw new Error("Device name must contain 1–80 characters");
		if (!deviceId.trim() || deviceId.length > 128) throw new Error("Device ID must contain 1–128 characters");
		const token = `cmem_sync_${randomBytes(32).toString("base64url")}`;
		const rows = await this.sql`
			INSERT INTO sync_device_tokens (user_id, device_id, name, token_hash)
			VALUES (${userId}, ${deviceId}, ${name.trim()}, ${tokenDigest(token)})
			ON CONFLICT (user_id, device_id) DO UPDATE
			SET name = EXCLUDED.name, token_hash = EXCLUDED.token_hash, created_at = now(), revoked_at = NULL
			WHERE sync_device_tokens.revoked_at IS NOT NULL
			RETURNING device_id
		`;
		if (rows.length === 0) throw new Error("Device already has an active token; revoke it before issuing another");
		return { token, userId, deviceId, name: name.trim() };
	}

	async list(userId: string) {
		return this.sql`
			SELECT device_id, name, created_at, revoked_at
			FROM sync_device_tokens WHERE user_id = ${userId} ORDER BY created_at, device_id
		`;
	}

	async revoke(userId: string, deviceId: string): Promise<boolean> {
		const rows = await this.sql`
			UPDATE sync_device_tokens SET revoked_at = COALESCE(revoked_at, now())
			WHERE user_id = ${userId} AND device_id = ${deviceId} RETURNING device_id
		`;
		return rows.length > 0;
	}

	async authenticate(request: Request, env: SyncApiEnv): Promise<AuthOk | AuthFail> {
		const authorization = request.headers.get("Authorization") ?? "";
		const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
		const userId = (request.headers.get("X-User-Id") ?? "").trim();
		const deviceId = (request.headers.get("X-Device-Id") ?? "").trim();
		const deviceName = (request.headers.get("X-Device-Name") ?? "").trim();
		if (!/^cmem_sync_[A-Za-z0-9_-]{43}$/.test(token) || userId !== env.SYNC_USER_ID || !deviceId || deviceId.length > 128) {
			return { ok: false, response: errorResponse(401, "invalid device credentials") };
		}
		if (deviceName.length > 80) return { ok: false, response: errorResponse(400, "X-Device-Name must be at most 80 characters") };
		const rows = await this.sql`
			SELECT device_id FROM sync_device_tokens
			WHERE token_hash = ${tokenDigest(token)} AND user_id = ${userId}
			  AND device_id = ${deviceId} AND revoked_at IS NULL
		`;
		if (rows.length === 0) return { ok: false, response: errorResponse(401, "invalid device credentials") };
		return { ok: true, userId, deviceId, deviceName: deviceName || null, authExpiresAtMs: Date.now() + 1_000 };
	}
}
