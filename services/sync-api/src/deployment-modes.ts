export const SYNC_AUTH_MODES = ["cmem", "local"] as const;
export type SyncAuthMode = typeof SYNC_AUTH_MODES[number];
export const SYNC_AUTH_MODE_LABELS: Record<SyncAuthMode, string> = {
	cmem: "CMEM account authentication",
	local: "Local device tokens",
};

export const SYNC_PROJECTION_MODES = ["external", "log"] as const;
export type SyncProjectionMode = typeof SYNC_PROJECTION_MODES[number];
export const SYNC_PROJECTION_MODE_LABELS: Record<SyncProjectionMode, string> = {
	external: "External search projection",
	log: "Standalone synchronization log",
};

export function deploymentMode<Value extends string>(raw: string | undefined, values: readonly Value[], fallback: Value, name: string): Value {
	const value = raw?.trim() || fallback;
	if (!values.includes(value as Value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
	return value as Value;
}
