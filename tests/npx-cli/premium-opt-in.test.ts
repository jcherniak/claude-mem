import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { providerNeedsAccount, startInstallerOAuthPairing } from '../../src/npx-cli/commands/install.js';
import { resolveInstallerProviderChoice } from '../../src/npx-cli/installer-provider-choice.js';

let previous: string | undefined;
beforeEach(() => { previous = process.env.CLAUDE_MEM_PREMIUM_ENABLED; delete process.env.CLAUDE_MEM_PREMIUM_ENABLED; });
afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_MEM_PREMIUM_ENABLED;
  else process.env.CLAUDE_MEM_PREMIUM_ENABLED = previous;
});

describe('installer premium opt-in', () => {
  it('does not require a CMEM account for personal model providers', () => {
    for (const provider of ['claude', 'host', 'codex', 'gemini', 'openrouter'] as const) expect(providerNeedsAccount(provider)).toBe(false);
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot' })).toBeUndefined();
  });

  it('does not start account enrollment with premium disabled', async () => {
    expect(await startInstallerOAuthPairing()).toBeNull();
  });

  it('preserves the hosted installer option with explicit opt-in', () => {
    process.env.CLAUDE_MEM_PREMIUM_ENABLED = 'true';
    expect(providerNeedsAccount('openrouter')).toBe(true);
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot' })).toBe('cmem');
  });
});
