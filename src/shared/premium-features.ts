export const PREMIUM_FEATURES_ENV = 'CLAUDE_MEM_PREMIUM_ENABLED';

export function premiumFeaturesEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  return environment[PREMIUM_FEATURES_ENV] === 'true';
}

export function isLocalSyncToken(token: string | undefined | null): boolean {
  return (token ?? '').trim().startsWith('cmem_sync_');
}

export function isCmemServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'cmem.ai' || hostname.endsWith('.cmem.ai');
  } catch {
    return false;
  }
}

export function hostedSyncToken(settings: { CLAUDE_MEM_CLOUD_SYNC_TOKEN?: string; CLAUDE_MEM_CLOUD_SYNC_HUB_URL?: string }): string | null {
  const token = settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN?.trim();
  if (!premiumFeaturesEnabled() || !token || isLocalSyncToken(token)) return null;
  if (!isCmemServiceUrl(settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL ?? '')) return null;
  return token;
}

export function assertSyncTokenDestination(token: string, hubUrl: string): void {
  if (isLocalSyncToken(token) && isCmemServiceUrl(hubUrl)) {
    throw new Error('Local device tokens cannot be sent to CMEM services. Configure your self-hosted sync URL.');
  }
}

export function premiumFetch(input: Parameters<typeof fetch>[0], init?: RequestInit, fetchImpl: typeof fetch = globalThis.fetch): ReturnType<typeof fetch> {
  if (!premiumFeaturesEnabled()) return Promise.reject(new Error(`${PREMIUM_FEATURES_ENV}=true is required for hosted premium features.`));
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const token = headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (isLocalSyncToken(token)) return Promise.reject(new Error('Local device tokens cannot authenticate hosted premium requests.'));
  return fetchImpl(input, { ...init, redirect: init?.redirect === 'manual' ? 'manual' : 'error' });
}
