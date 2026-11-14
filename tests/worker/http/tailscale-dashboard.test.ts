import { afterEach, describe, expect, it } from 'bun:test';
import { trustedTailscaleDashboardRequest } from '../../../src/services/worker/http/tailscale-dashboard.js';
import { isForeignLoopbackBrowserWrite } from '../../../src/services/worker/http/routes/SettingsRoutes.js';
import { workViewLoopbackOnly } from '../../../src/services/worker/http/routes/WorkViewRoutes.js';

const origin = 'https://host.example.ts.net:8445';
const original = process.env.CLAUDE_MEM_TAILSCALE_DASHBOARD_ORIGIN;
afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_MEM_TAILSCALE_DASHBOARD_ORIGIN;
  else process.env.CLAUDE_MEM_TAILSCALE_DASHBOARD_ORIGIN = original;
});
const request = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: {
  host: 'host.example.ts.net:8445', 'tailscale-user-login': 'test@example.test', 'x-forwarded-proto': 'https', origin,
} });

describe('explicit Tailscale dashboard proxy', () => {
  it('requires the environment opt-in, a loopback peer, identity, HTTPS, and exact origin', () => {
    expect(trustedTailscaleDashboardRequest(request(), '')).toBe(false);
    expect(trustedTailscaleDashboardRequest(request(), origin)).toBe(true);
    for (const address of ['100.64.0.1', '192.168.1.2', '8.8.8.8']) {
      expect(trustedTailscaleDashboardRequest({ ...request(), socket: { remoteAddress: address } }, origin)).toBe(false);
    }
    for (const replacement of [{ host: 'foreign.example' }, { 'tailscale-user-login': '' }, { 'x-forwarded-proto': 'http' },
      { origin: 'https://foreign.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect(trustedTailscaleDashboardRequest({ ...request(), headers: { ...request().headers, ...replacement } }, origin)).toBe(false);
    }
    for (const configured of ['https://foreign.example', `${origin}/path`, `${origin}?query=true`, 'http://host.example.ts.net:8445']) {
      expect(trustedTailscaleDashboardRequest(request(), configured)).toBe(false);
    }
  });

  it('admits trusted proxy requests at both the work-view and browser-write guards', () => {
    process.env.CLAUDE_MEM_TAILSCALE_DASHBOARD_ORIGIN = origin;
    expect(isForeignLoopbackBrowserWrite(request() as any)).toBe(false);
    let admitted = false;
    workViewLoopbackOnly(request() as any, { status: () => { throw new Error('unexpected refusal'); } } as any, () => { admitted = true; });
    expect(admitted).toBe(true);
    delete process.env.CLAUDE_MEM_TAILSCALE_DASHBOARD_ORIGIN;
    expect(isForeignLoopbackBrowserWrite(request() as any)).toBe(true);
  });
});
