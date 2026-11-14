import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Server as HttpServer } from 'node:http';
import { WorkerService } from '../../src/services/worker-service.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { WORKER_MODES, WORKER_MODE_LABELS, resolveWorkerMode } from '../../src/shared/worker-mode.js';
import { MemoryFeedInvalidation } from '../../src/services/worker/MemoryFeedInvalidation.js';
import { ViewerSyncService } from '../../src/services/sync/ViewerSyncService.js';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import * as preflight from '../../src/services/worker/dependency-preflight.js';
import * as provisioning from '../../src/services/worker/tree-sitter-cli-provisioning.js';
import * as restore from '../../src/services/backup/restore-swap.js';
import * as processManager from '../../src/services/infrastructure/ProcessManager.js';
import * as cleanup from '../../src/services/infrastructure/CleanupV12_4_3.js';
import * as fts from '../../src/services/infrastructure/FtsMaintenance.js';
import * as adoption from '../../src/services/infrastructure/WorktreeAdoption.js';
import * as graceful from '../../src/services/infrastructure/GracefulShutdown.js';
import { logger } from '../../src/utils/logger.js';

let worker: any;
let http: HttpServer | undefined;
afterEach(async () => {
  spyOn(graceful, 'performGracefulShutdown').mockResolvedValue(undefined);
  if (worker) { await worker.shutdown('stop'); await worker.dbManager.close(); }
  if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
  worker = undefined;
  http = undefined;
  mock.restore();
});

describe('engine-only worker', () => {
  it('defaults to the dashboard mode and rejects unknown modes', () => {
    expect(resolveWorkerMode({})).toBe(WORKER_MODES[0]);
    expect(() => resolveWorkerMode({ CLAUDE_MEM_WORKER_MODE: 'unknown' })).toThrow('Invalid CLAUDE_MEM_WORKER_MODE');
  });

  it('starts core APIs without dashboard routes, stores, or background services', async () => {
    const mode = WORKER_MODES[1];
    const settings = { ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_WORKER_MODE: mode, CLAUDE_MEM_CHROMA_ENABLED: 'false' };
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(settings);
    for (const method of ['info', 'warn', 'error', 'debug'] as const) spyOn(logger, method).mockImplementation(() => {});
    spyOn(WorkerService.prototype as any, 'registerSignalHandlers').mockImplementation(() => {});
    spyOn(preflight, 'runWorkerDependencyPreflight').mockReturnValue({ degraded: false, statuses: [] } as any);
    spyOn(provisioning, 'provisionTreeSitterCliForPluginRoot').mockResolvedValue('no-package');
    spyOn(restore, 'applyPendingRestore').mockResolvedValue(undefined as any);
    spyOn(processManager, 'runOneTimeCwdRemap').mockImplementation(() => {});
    spyOn(cleanup, 'runOneTimeV12_4_3Cleanup').mockImplementation(() => {});
    spyOn(fts, 'scheduleOneTimeFtsBloatReclaim').mockImplementation(() => {});
    spyOn(adoption, 'adoptMergedWorktreesForAllKnownRepos').mockResolvedValue([]);
    const feed = spyOn(MemoryFeedInvalidation.prototype, 'start');
    const viewer = spyOn(ViewerSyncService.prototype, 'start');
    const refresh = spyOn(AutoRefreshWorker.prototype, 'readNeeds');
    worker = new WorkerService();
    expect(() => worker.runningBackgroundJobNames()).toThrow('initialization has not completed');
    spyOn(worker, 'startHookSpoolDrain').mockImplementation(() => {});
    spyOn(worker, 'startTranscriptWatcher').mockResolvedValue(undefined);
    spyOn(worker, 'runMcpSelfCheck').mockResolvedValue(undefined);
    spyOn(worker, 'startIdleExitMonitor').mockImplementation(() => {});
    await new Promise<void>(resolve => { http = worker.server.app.listen(0, '127.0.0.1', resolve); });
    const address = http!.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const origin = `http://127.0.0.1:${address.port}`;
    await worker.initializeBackground();
    expect(worker.initializationCompleteFlag).toBe(true);
    expect(worker.workViewRoutes).toBeNull();
    expect(worker.corpusStore).toBeNull();
    expect(worker.corpusRoutes).toBeNull();
    expect(worker.sharedWorkSync).toBeNull();
    expect(worker.runningBackgroundJobNames()).toEqual([]);
    expect(feed).not.toHaveBeenCalled();
    expect(viewer).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(await (await fetch(`${origin}/api/health`)).json()).toMatchObject({ workerMode: mode, workerModeLabel: WORKER_MODE_LABELS[mode], initialized: true });
    for (const path of ['/api/readiness', '/api/settings', '/api/sync/status']) expect((await fetch(`${origin}${path}`)).status).toBe(200);
    for (const path of ['/', '/viewer.html', '/work-view/index.html', '/api/work-view']) expect((await fetch(`${origin}${path}`)).status).toBe(404);
  });
});
