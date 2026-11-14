import { parseArgs } from "node:util";
import postgres from "postgres";
import { DeviceTokens } from "./device-tokens";
import { loadEnv, type SyncApiEnv } from "./env";
import { applyMigrations } from "./schema";

export async function deviceCommand(args: string[], env: SyncApiEnv, sql: postgres.Sql) {
	if (env.SYNC_AUTH_MODE !== "local") throw new Error("Device commands require SYNC_AUTH_MODE=local");
	const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { "device-id": { type: "string" } } });
	const [resource, command, value, ...extra] = positionals;
	if (resource !== "device" || extra.length > 0) throw new Error("Usage: device add <name> [--device-id <id>] | device list | device revoke <id>");
	const devices = new DeviceTokens(sql);
	if (command === "list" && value === undefined && values["device-id"] === undefined) return devices.list(env.SYNC_USER_ID);
	if (command === "revoke" && value && values["device-id"] === undefined) {
		if (!await devices.revoke(env.SYNC_USER_ID, value)) throw new Error("Device not found");
		return { device_id: value, revoked: true };
	}
	if (command !== "add" || !value) throw new Error("Usage: device add <name> [--device-id <id>] | device list | device revoke <id>");
	const url = new URL(env.SYNC_PUBLIC_URL);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
		|| url.username || url.password || url.search || url.hash) throw new Error("SYNC_PUBLIC_URL must be HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment");
	const device = await devices.add(env.SYNC_USER_ID, value, values["device-id"]);
	return {
		device_id: device.deviceId,
		name: device.name,
		settings: {
			CLAUDE_MEM_CLOUD_SYNC_HUB_URL: url.toString().replace(/\/+$/, ""),
			CLAUDE_MEM_CLOUD_SYNC_USER_ID: device.userId,
			CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: device.deviceId,
			CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: device.name,
			CLAUDE_MEM_CLOUD_SYNC_TOKEN: device.token,
			CLAUDE_MEM_CLOUD_SYNC_WS: "false",
		},
	};
}

if (import.meta.main) {
	let sql: postgres.Sql | undefined;
	try {
		const env = loadEnv();
		if (env.FORWARD_ORIGIN !== null) throw new Error("Device commands are not available in forward mode");
		sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10, connection: { options: "-c statement_timeout=20000 -c lock_timeout=15000" } });
		await applyMigrations(sql);
		console.log(JSON.stringify(await deviceCommand(process.argv.slice(2), env, sql), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Device command failed");
		process.exitCode = 1;
	} finally {
		await sql?.end({ timeout: 5 });
	}
}
