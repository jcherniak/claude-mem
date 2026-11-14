import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { assertSyncTokenDestination, hostedSyncToken, isCmemServiceUrl, premiumFeaturesEnabled, premiumFetch } from '../../src/shared/premium-features.js';
import { isKeyAllowedForEndpoint, keysForEndpoint, proFallbackNotice } from '../../src/shared/cmem-gateway.js';
import { buildAnthropicMaxLocalSettings } from '../../src/npx-cli/cmem-memory-credentials.js';
import { teamBrainConnection } from '../../src/shared/teambrain.js';
import { proTrialLine } from '../../src/shared/pro-promo.js';
import { MediaCloudClient } from '../../src/services/media/cloud.js';
import { HistoryImport } from '../../src/services/setup/history-import.js';
import { classifySyncAuthFailure, friendlySyncError } from '../../src/shared/sync-health.js';

const localToken = 'cmem_sync_test-only-not-a-real-token';
const localSettings = { CLAUDE_MEM_CLOUD_SYNC_TOKEN: localToken, CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.example.test' };
let previous: string | undefined;
beforeEach(() => { previous = process.env.CLAUDE_MEM_PREMIUM_ENABLED; delete process.env.CLAUDE_MEM_PREMIUM_ENABLED; });
afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_MEM_PREMIUM_ENABLED;
  else process.env.CLAUDE_MEM_PREMIUM_ENABLED = previous;
});

describe('premium feature isolation', () => {
  it('requires an explicit environment opt-in', () => {
    for (const value of [undefined, '', 'false', '1', 'TRUE']) expect(premiumFeaturesEnabled({ CLAUDE_MEM_PREMIUM_ENABLED: value })).toBe(false);
    expect(premiumFeaturesEnabled({ CLAUDE_MEM_PREMIUM_ENABLED: 'true' })).toBe(true);
    expect(proTrialLine('installer')).toBe('');
    expect(hostedSyncToken({ CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'managed-token', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai' })).toBeNull();
    expect(keysForEndpoint('https://cmem.ai/api/inference/v1', ['cm_pro_test'])).toEqual([]);
    expect(isKeyAllowedForEndpoint('https://api.openai.com/v1', 'personal-key')).toBe(true);
    expect(proFallbackNotice({ url: 'https://cmem.ai/pro', message: 'Renew at https://cmem.ai/pro' })).not.toContain('https://');
    expect(classifySyncAuthFailure(401, '{}')?.message).toContain('device token');
    expect(classifySyncAuthFailure(403, '{"code":"subscription_inactive"}')?.message).not.toContain('cmem.ai');
    expect(friendlySyncError(`Server echoed ${localToken}`)).not.toContain('test-only');
  });

  it('never treats local sync credentials as CMEM credentials, including with premium enabled', () => {
    process.env.CLAUDE_MEM_PREMIUM_ENABLED = 'true';
    expect(hostedSyncToken(localSettings)).toBeNull();
    expect(hostedSyncToken({ ...localSettings, CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai' })).toBeNull();
    expect(hostedSyncToken({ ...localSettings, CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'custom-api-token' })).toBeNull();
    expect(hostedSyncToken({ CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'managed-token', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai' })).toBe('managed-token');
    expect(teamBrainConnection({ ...localSettings, CLAUDE_MEM_TEAMBRAIN_URL: 'https://cmem.ai/team/test' })).toBeNull();
    for (const endpoint of ['https://cmem.ai/api/inference/v1', 'https://api.openai.com/v1']) {
      expect(isKeyAllowedForEndpoint(endpoint, localToken)).toBe(false);
      expect(keysForEndpoint(endpoint, [localToken])).toEqual([]);
    }
  });

  it('blocks premium sends before invoking the transport', async () => {
    let calls = 0;
    const transport = (async () => { calls++; return new Response(); }) as typeof fetch;
    await expect(premiumFetch('https://cmem.ai', {}, transport)).rejects.toThrow('CLAUDE_MEM_PREMIUM_ENABLED');
    process.env.CLAUDE_MEM_PREMIUM_ENABLED = 'true';
    await expect(premiumFetch('https://cmem.ai', { headers: { authorization: `Bearer ${localToken}` } }, transport)).rejects.toThrow('Local device tokens');
    await expect(premiumFetch(new Request('https://cmem.ai', { headers: { authorization: `Bearer ${localToken}` } }), undefined, transport)).rejects.toThrow('Local device tokens');
    expect(calls).toBe(0);
  });

  it('does not follow hosted redirects when premium is enabled', async () => {
    process.env.CLAUDE_MEM_PREMIUM_ENABLED = 'true';
    let redirect: RequestRedirect | undefined;
    await premiumFetch('https://cmem.ai', { redirect: 'follow' }, (async (_input, init) => { redirect = init?.redirect; return new Response(); }) as typeof fetch);
    expect(redirect).toBe('error');
  });

  it('blocks local device tokens at media and history-import entry points', async () => {
    process.env.CLAUDE_MEM_PREMIUM_ENABLED = 'true';
    let requests = 0;
    const transport = (async () => { requests++; return new Response(); }) as typeof fetch;
    const media = new MediaCloudClient({ baseUrl: 'https://cmem.ai', token: localToken, fetchImpl: transport });
    expect(await media.describe('11111111-1111-4111-8111-111111111111')).toMatchObject({ kind: 'retry' });
    const history = new HistoryImport({ openDatabase: () => { throw new Error('must not open'); }, origin: () => 'https://cmem.ai', token: () => localToken, fetch: transport });
    expect(() => history.start()).toThrow('disabled');
    expect(requests).toBe(0);
  });

  it('allows self-hosted sync with premium disabled but rejects CMEM hosts', () => {
    expect(() => assertSyncTokenDestination(localToken, localSettings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL)).not.toThrow();
    for (const url of ['https://cmem.ai', 'https://SYNC.CMEM.AI./v1', 'http://work.cmem.ai:8080']) {
      expect(isCmemServiceUrl(url)).toBe(true);
      expect(() => assertSyncTokenDestination(localToken, url)).toThrow('Local device tokens');
    }
    expect(isCmemServiceUrl('https://cmem.ai.example.test')).toBe(false);
    expect(isCmemServiceUrl('https://cmem.ai@example.test')).toBe(false);
  });

  it('preserves self-hosted sync when selecting a personal Claude subscription', () => {
    const updated = { ...localSettings, ...buildAnthropicMaxLocalSettings(localSettings) };
    expect(updated.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe(localToken);
    expect(updated.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe(localSettings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);
    expect(updated.CLAUDE_MEM_PROVIDER).toBe('claude');
  });
});
