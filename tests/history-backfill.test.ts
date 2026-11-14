import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { Readable } from 'node:stream';
import { completeLines } from '../src/services/history-backfill/lines.js';
import { historicalHash, HistoricalJournal, runHistoricalBackfill, type HistoricalResult, type Snapshot } from '../src/services/history-backfill/runner.js';
import { discoverHistoricalSources, nativeJsonlEvents, redactHistoricalText, sanitizeEvents, type HistoricalEvent } from '../src/services/history-backfill/sources.js';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(events: HistoricalEvent[] = [{ role: 'user', text: 'Keep the host loopback-only.' }, { role: 'assistant', text: 'The loopback guard is now tested.' }]) {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-historical-'));
  temporary.push(directory);
  const file = join(directory, 'source.jsonl');
  const text = events.map(event => `${JSON.stringify(event)}\n`).join('');
  writeFileSync(file, text);
  const snapshot: Snapshot = { file, digest: historicalHash(text), events: events.length, host: 'local', id: 'original-session', platform: 'claude', project: 'example', path: '/original.jsonl', cwd: '/example' };
  writeFileSync(join(directory, 'catalog.json'), JSON.stringify([snapshot]));
  return { directory, snapshot, options: { directory, workerUrl: 'http://127.0.0.1:37701', continued: false, retryUncertain: false, seconds: 60, maxCalls: 0 } };
}
const output: HistoricalResult = { state: 'Loopback guard completed and tested.', memories: [{ title: 'Loopback guard', text: 'The host accepts only loopback traffic.' }] };
async function collect(events: AsyncIterable<HistoricalEvent>): Promise<HistoricalEvent[]> { const result = []; for await (const event of events) result.push(event); return result; }

describe('explicit historical workflow', () => {
  it('saves once, then an explicit continuation performs no new inference', async () => {
    const { options } = fixture(); let calls = 0; let saves = 0;
    const run = { ...options, generate: async () => { calls++; return output; }, save: async () => { saves++; } };
    expect((await runHistoricalBackfill(run)).calls).toBe(1);
    await expect(runHistoricalBackfill(run)).rejects.toThrow('explicit --continue');
    expect((await runHistoricalBackfill({ ...run, continued: true })).calls).toBe(0);
    expect(calls).toBe(1); expect(saves).toBe(1);
  });
  for (const failure of ['quota exhausted', 'authentication failed', 'network outcome uncertain']) {
    it(`stops on ${failure}; neither restart nor continuation authorizes a new paid request`, async () => {
      const { options } = fixture(); let calls = 0;
      const generate = async () => { calls++; throw new Error(failure); };
      await expect(runHistoricalBackfill({ ...options, generate })).rejects.toThrow(failure);
      await expect(runHistoricalBackfill({ ...options, generate })).rejects.toThrow('--continue');
      await expect(runHistoricalBackfill({ ...options, generate, continued: true })).rejects.toThrow('uncertain outcome');
      expect(calls).toBe(1);
    });
  }
  it('retains generated output across a failed save and does not pay again', async () => {
    const { options } = fixture(); let calls = 0;
    const generate = async () => { calls++; return output; };
    await expect(runHistoricalBackfill({ ...options, generate, save: async () => { throw new Error('store offline'); } })).rejects.toThrow('store offline');
    const saved: string[] = [];
    const result = await runHistoricalBackfill({ ...options, continued: true, generate, save: async (_url, _source, checkpoint) => { saved.push(checkpoint.fingerprint); } });
    expect(calls).toBe(1); expect(result.calls).toBe(0); expect(saved).toHaveLength(1);
  });
  it('continues from the matching source position and reducer state at a call limit', async () => {
    const { options } = fixture([{ role: 'user', text: 'a'.repeat(100000) }, { role: 'assistant', text: 'second chunk' }]);
    const prompts: string[] = [];
    const generate = async (prompt: string) => { prompts.push(prompt); return output; };
    const save = async () => {};
    const first = await runHistoricalBackfill({ ...options, generate, save, maxCalls: 1 });
    expect(first.timeLimited).toBe(true);
    const second = await runHistoricalBackfill({ ...options, generate, save, continued: true });
    expect(second.calls).toBe(1);
    expect(prompts[1]).toContain(output.state); expect(prompts[1]).toContain('second chunk'); expect(prompts[1]).not.toContain('a'.repeat(100));
  });
  it('rejects a changed snapshot before inference', async () => {
    const { options, snapshot } = fixture(); let calls = 0;
    writeFileSync(snapshot.file, 'changed\n');
    await expect(runHistoricalBackfill({ ...options, generate: async () => { calls++; return output; } })).rejects.toThrow('snapshot changed');
    expect(calls).toBe(0);
  });
  it('does not send history to a remote or redirected worker URL', async () => {
    const { options } = fixture();
    await expect(runHistoricalBackfill({ ...options, workerUrl: 'https://cmem.ai' })).rejects.toThrow('loopback');
  });
  it('persists a source checkpoint and not a live observer queue', () => {
    const { directory, snapshot } = fixture(); const journal = new HistoricalJournal(directory);
    const key = historicalHash(snapshot.digest); journal.checkpoint(key); journal.begin(key, 3, 'request'); journal.generated(key, output); journal.committed(key, 3, output.state);
    expect(journal.checkpoint(key)).toMatchObject({ position: 3, state: output.state, inflight: 0, output: null }); journal.close();
  });
});

describe('historical source privacy and native schemas', () => {
  it('preserves long UTF-8 records across chunks and asynchronous consumer delays', async () => {
    const records = Array.from({ length: 20 }, (_, index) => JSON.stringify({ index, text: 'source ☃ '.repeat(3000) }));
    const bytes = Buffer.from(records.join('\n')+'\n'); const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 8191) chunks.push(bytes.subarray(offset, offset+8191));
    const received = [];
    for await (const line of completeLines(Readable.from(chunks))) { await new Promise(resolve => setTimeout(resolve, 1)); received.push(line); }
    expect(received).toEqual(records);
  });
  it('removes sync tokens, API tokens, private sections and private keys', () => {
    const text = redactHistoricalText('cmem_sync_testsecret <private>hidden</private> Bearer secret.token sk-abcdefghijklmnopqrst -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----');
    for (const secret of ['testsecret', 'hidden', 'secret.token', 'abcdefghijklmnopqrst', '\nkey\n']) expect(text).not.toContain(secret);
  });
  it('excludes an entire private turn, not just its user prompt', async () => {
    const source = (async function* () { yield { role: 'user', text: '<private>secret</private>' }; yield { role: 'assistant', text: 'secret reply' }; yield { role: 'tool', text: 'secret result' }; yield { role: 'user', text: 'public request' }; yield { role: 'assistant', text: 'public response' }; })();
    expect(await collect(sanitizeEvents(source))).toEqual([{ role: 'user', text: 'public request' }, { role: 'assistant', text: 'public response' }]);
  });
  it('splits large evidence without truncating it', async () => {
    const text = 'evidence '.repeat(20000);
    const events = await collect(sanitizeEvents((async function* () { yield { role: 'tool', text }; })()));
    expect(events.map(event => event.text).join('')).toBe(text.trim()); expect(events.every(event => event.text.length <= 16000)).toBe(true);
  });
  it('reads Codex response items once, not duplicate UI event messages', async () => {
    const { directory } = fixture(); const path = join(directory, 'codex.jsonl');
    writeFileSync(path, [{ type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'request' }] } }, { type: 'response_item', payload: { type: 'function_call_output', output: 'result' } }].map(row => JSON.stringify(row)).join('\n'));
    expect(await collect(nativeJsonlEvents(path, 'codex'))).toEqual([{ role: 'user', text: 'request' }, { role: 'tool', text: 'result' }]);
  });
  it('reads Cursor roles from the envelope, not only the message body', async () => {
    const { directory } = fixture(); const path = join(directory, 'cursor.jsonl');
    writeFileSync(path, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'The fix passed its tests.' }] } })+'\n');
    expect(await collect(nativeJsonlEvents(path, 'cursor'))).toEqual([{ role: 'assistant', text: 'The fix passed its tests.' }]);
  });
  it('preserves source dates rather than substituting the import time', async () => {
    const { directory } = fixture(); const path = join(directory, 'dated.jsonl');
    writeFileSync(path, JSON.stringify({ timestamp: '2020-01-01T00:00:00Z', role: 'assistant', message: { content: 'Historical result.' } })+'\n');
    expect(await collect(sanitizeEvents(nativeJsonlEvents(path, 'cursor')))).toEqual([{ role: 'assistant', text: 'Historical result.', at: '2020-01-01T00:00:00.000Z' }]);
  });
  it('marks corrupt records as gaps and excludes the unknown privacy boundary', async () => {
    const { directory } = fixture(); const path = join(directory, 'corrupt.jsonl'); const warnings: string[] = [];
    const row = (role: string, content: string) => JSON.stringify({ role, message: { content } });
    writeFileSync(path, [row('user', 'before'), '{broken', row('assistant', 'possibly private'), row('user', 'public next turn'), row('assistant', 'public result')].join('\n'));
    const events = await collect(sanitizeEvents(nativeJsonlEvents(path, 'cursor', message => warnings.push(message))));
    expect(warnings).toHaveLength(1); expect(events.map(event => event.role)).toEqual(['user', 'gap', 'user', 'assistant']); expect(JSON.stringify(events)).not.toContain('possibly private');
  });
  it('reads retained Hermes messages without modifying the native database', async () => {
    const { directory } = fixture(); mkdirSync(join(directory, '.hermes'));
    const database = new Database(join(directory, '.hermes/state.db'));
    database.exec('CREATE TABLE sessions(id TEXT, cwd TEXT, started_at REAL); CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL);');
    database.query('INSERT INTO sessions VALUES (?, ?, ?)').run('native-hermes', '/example', 1577836800);
    database.query('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(1, 'native-hermes', 'user', 'Keep this decision.', null, 1577836800);
    const sources = []; for await (const source of discoverHistoricalSources(directory, () => {})) { sources.push({ id: source.id, events: await collect(source.events()) }); }
    expect(sources).toEqual([{ id: 'native-hermes', events: [{ role: 'user', text: 'Keep this decision.', at: '2020-01-01T00:00:00.000Z' }] }]);
    expect(database.query('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 1 }); database.close();
  });
  it('reads Cursor JSON message blobs and excludes binary blobs without changing the source', async () => {
    const { directory } = fixture(); const folder = join(directory, '.cursor/chats/project/native-session'); mkdirSync(folder, { recursive: true });
    const database = new Database(join(folder, 'store.db')); database.exec('CREATE TABLE blobs(id TEXT, data BLOB)');
    database.query('INSERT INTO blobs VALUES (?, ?)').run('user', JSON.stringify({ role: 'user', content: 'Keep the result.' }));
    database.query('INSERT INTO blobs VALUES (?, ?)').run('agent', JSON.stringify({ role: 'assistant', content: 'The test passed.' }));
    database.query('INSERT INTO blobs VALUES (?, ?)').run('binary', Buffer.from([255, 128]));
    const sources = []; for await (const source of discoverHistoricalSources(directory, () => {})) sources.push({ unordered: source.unordered, events: await collect(source.events()) });
    expect(sources).toEqual([{ unordered: true, events: [{ role: 'user', text: 'Keep the result.' }, { role: 'assistant', text: 'The test passed.' }] }]);
    expect(database.query('SELECT count(*) AS count FROM blobs').get()).toEqual({ count: 3 }); database.close();
  });
  it('keeps all dates when discovering Claude transcripts', async () => {
    const { directory } = fixture(); const root = join(directory, '.claude/projects/example'); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'old.jsonl'), JSON.stringify({ sessionId: 'old', cwd: '/example', timestamp: '2020-01-01', message: { role: 'user', content: 'old request' } })+'\n');
    const sources = []; for await (const source of discoverHistoricalSources(directory, () => {})) sources.push(source);
    expect(sources).toHaveLength(1); expect(sources[0].id).toBe('old'); expect(await collect(sources[0].events())).toEqual([{ role: 'user', text: 'old request', at: '2020-01-01T00:00:00.000Z' }]);
    expect(readFileSync(join(root, 'old.jsonl'), 'utf8')).toContain('2020-01-01');
  });
});
