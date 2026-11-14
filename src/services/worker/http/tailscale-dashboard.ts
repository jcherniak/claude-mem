import type { IncomingHttpHeaders } from 'node:http';

type DashboardRequest = {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string };
};

export function trustedTailscaleDashboardRequest(req: DashboardRequest, configuredOrigin = process.env.CLAUDE_MEM_TAILSCALE_DASHBOARD_ORIGIN): boolean {
  if (!configuredOrigin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')) return false;
  try {
    const url = new URL(configuredOrigin);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.origin !== configuredOrigin.replace(/\/$/, '')) return false;
    const host = req.headers.host;
    const identity = req.headers['tailscale-user-login'];
    if (typeof host !== 'string' || host.toLowerCase() !== url.host.toLowerCase()
      || typeof identity !== 'string' || !identity.trim() || req.headers['x-forwarded-proto'] !== 'https'
      || req.headers['sec-fetch-site'] === 'cross-site') return false;
    return req.headers.origin === undefined || req.headers.origin === url.origin;
  } catch {
    return false;
  }
}
