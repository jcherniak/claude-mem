export const WORKER_MODES = ['full', 'engine-only'] as const;
export type WorkerMode = typeof WORKER_MODES[number];
export const WORKER_MODE_LABELS: Record<WorkerMode, string> = {
  full: 'Engine and dashboard',
  'engine-only': 'Engine only',
};

export function resolveWorkerMode(settings: { CLAUDE_MEM_WORKER_MODE?: string }): WorkerMode {
  const value = settings.CLAUDE_MEM_WORKER_MODE ?? WORKER_MODES[0];
  if (!WORKER_MODES.includes(value as WorkerMode)) throw new Error(`Invalid CLAUDE_MEM_WORKER_MODE: ${value}`);
  return value as WorkerMode;
}

export function workerDashboardEnabled(mode: WorkerMode): boolean {
  return mode === WORKER_MODES[0];
}
