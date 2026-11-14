import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { stripMemoryTags, stripSystemReminderBlocks } from '../../utils/tag-stripping.js';
import { isProjectExcluded } from '../../utils/project-filter.js';

export interface HistoricalEvent { role: string; text: string; at?: string }
export interface HistoricalSource {
  id: string;
  platform: string;
  project: string;
  path: string;
  cwd: string;
  unordered?: boolean;
  events: () => AsyncIterable<HistoricalEvent>;
}

export function redactHistoricalText(text: string): string {
  return stripSystemReminderBlocks(stripMemoryTags(text))
    .replace(/cmem_sync_[A-Za-z0-9_-]+/g, '[REDACTED_SYNC_TOKEN]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_API_TOKEN]');
}

export function historicalText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(historicalText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'tool_use') return `${value.name}\n${JSON.stringify(value.input)}`;
  return historicalText(value.text ?? value.content ?? value.value ?? value.parts ?? '');
}

function sourceTimestamp(value: unknown): string | undefined {
  const epoch = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
}

export async function* jsonLines(path: string, report?: (message: string) => void): AsyncGenerator<any> {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let number = 0;
    for await (const line of lines) {
      number++;
      if (!line.trim()) continue;
      try { yield JSON.parse(line); }
      catch {
        if (!report) throw new Error(`Invalid transcript JSON: ${path}:${number}`);
        report(`Unreadable JSONL record: ${path}:${number}`);
        yield { historicalGap: number };
      }
    }
  } finally { lines.close(); stream.destroy(); }
}

function* files(root: string, accept: (path: string) => boolean): Generator<string> {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, accept);
    else if (entry.isFile() && accept(path)) yield path;
  }
}

export async function* sanitizeEvents(events: AsyncIterable<HistoricalEvent>): AsyncGenerator<HistoricalEvent> {
  let privateTurn = false;
  for await (const event of events) {
    if (event.role === 'gap') { privateTurn = true; yield event; continue; }
    if (event.role === 'user') privateTurn = event.text.trim() !== '' && stripMemoryTags(event.text).trim() === '';
    if (privateTurn) continue;
    const text = redactHistoricalText(event.text).trim();
    if (!text) continue;
    for (let offset = 0; offset < text.length; offset += 16000) {
      yield { ...event, text: text.slice(offset, offset + 16000) };
    }
  }
}

export async function* nativeJsonlEvents(path: string, platform: string, report?: (message: string) => void): AsyncGenerator<HistoricalEvent> {
  for await (const row of jsonLines(path, report)) {
    if (row.historicalGap) { yield { role: 'gap', text: 'A source record is unreadable. This evidence is incomplete; do not infer what it contained.' }; continue; }
    const message = platform === 'codex' ? (row.type === 'response_item' ? row.payload : null) : (row.message ?? row);
    if (!message) continue;
    const role = message.role ?? row.role;
    const at = sourceTimestamp(row.timestamp ?? message.timestamp);
    if (['user', 'assistant', 'tool'].includes(role)) {
      const text = historicalText(message.content);
      if (text) yield { role, text, ...(at ? { at } : {}) };
    } else if (platform === 'codex' && message.type === 'function_call') {
      yield { role: 'assistant', text: `${message.name}\n${message.arguments ?? ''}`, ...(at ? { at } : {}) };
    } else if (platform === 'codex' && message.type === 'function_call_output') {
      yield { role: 'tool', text: historicalText(message.output), ...(at ? { at } : {}) };
    }
  }
}

async function jsonlIdentity(path: string, platform: string, report: (message: string) => void): Promise<{ id: string; cwd: string }> {
  let cwd = '';
  let id = basename(path, '.jsonl');
  let count = 0;
  for await (const row of jsonLines(path, report)) {
    if (platform === 'codex' && row.type === 'session_meta') {
      id = row.payload?.id ?? id;
      cwd = row.payload?.cwd ?? '';
      break;
    }
    cwd ||= typeof row.cwd === 'string' ? row.cwd : '';
    id = row.sessionId ?? id;
    if (cwd || ++count >= 20) break;
  }
  return { id, cwd };
}

function projectFor(cwd: string, fallback: string): string {
  return basename(cwd || fallback).replace(/^-+/, '') || 'historical-memory';
}

async function* cursorMessages(path: string): AsyncGenerator<any> {
  const program = `import json,pathlib,sqlite3,sys
database=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True)
try:
 database.execute("BEGIN")
 for pass_index in range(2):
  for (data,) in database.execute("SELECT data FROM blobs ORDER BY rowid"):
   try: message=json.loads(data)
   except (ValueError,UnicodeError): continue
   if isinstance(message,dict) and message.get("role") in ("user","assistant","tool"):
    print(json.dumps(message),flush=True)
  print(json.dumps({"historicalPassEnd":True,"passIndex":pass_index}),flush=True)
  if pass_index==0: sys.stdin.readline()
finally:
 database.close()
`;
  const child = spawn('python3', ['-c', program, path], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const complete = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Cursor database could not be read with Python SQLite')));
  });
  void complete.catch(() => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const message = JSON.parse(line);
      yield message;
      if (message.historicalPassEnd && message.passIndex === 0) child.stdin.write('\n');
    }
    await complete;
  }
  finally { lines.close(); child.stdout.destroy(); child.kill(); }
}

export async function* discoverHistoricalSources(home: string, report: (message: string) => void): AsyncGenerator<HistoricalSource> {
  let excluded = '';
  const settingsPath = join(home, '.claude-mem', 'settings.json');
  if (existsSync(settingsPath)) excluded = JSON.parse(readFileSync(settingsPath, 'utf8')).CLAUDE_MEM_EXCLUDED_PROJECTS ?? '';
  const cursorIds = new Set<string>();
  for (const [platform, roots] of [
    ['claude', [join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')]],
    ['codex', ['sessions', 'archived_sessions'].map(folder => join(process.env.CODEX_HOME || join(home, '.codex'), folder))],
    ['cursor', [join(home, '.cursor', 'projects')]],
  ] as Array<[string, string[]]>) {
    for (const root of roots) for (const path of files(root, path => path.endsWith('.jsonl') && (platform !== 'cursor' || path.includes('/agent-transcripts/')))) {
      let identity;
      try { identity = await jsonlIdentity(path, platform, report); }
      catch { report(`Unreadable transcript: ${path}`); continue; }
      if (excluded && !identity.cwd) { report(`No project identity for exclusion checks: ${path}`); continue; }
      if (identity.cwd && isProjectExcluded(identity.cwd, excluded)) { report(`Excluded project: ${identity.cwd}`); continue; }
      if (platform === 'cursor') cursorIds.add(identity.id);
      yield { ...identity, platform, project: projectFor(identity.cwd, platform === 'cursor' ? 'cursor-history' : dirname(path)), path, events: () => sanitizeEvents(nativeJsonlEvents(path, platform, report)) };
    }
  }
  for (const path of files(join(home, '.cursor', 'chats'), path => path.endsWith('/store.db'))) {
    if (excluded) { report(`No project identity for exclusion checks: ${path}`); continue; }
    const id = basename(dirname(path));
    if (cursorIds.has(id)) continue;
    let privateSource = false;
    const messages = cursorMessages(path);
    try {
      while (true) {
        const next = await messages.next();
        if (next.done) throw new Error('Cursor privacy scan ended before its boundary');
        const message = next.value;
        if (message.historicalPassEnd) break;
        const text = historicalText(message.content);
        if (message.role === 'user' && text.trim() && !stripMemoryTags(text).trim()) privateSource = true;
      }
      if (privateSource) { report(`Private Cursor fragments excluded: ${path}`); continue; }
      yield { id, platform: 'cursor', project: 'cursor-history', path, cwd: '', unordered: true, events: () => sanitizeEvents((async function* () {
        for await (const message of messages) {
          const text = redactHistoricalText(historicalText(message.content));
          if (text) yield { role: message.role, text };
        }
      })()) };
    } catch { report(`Cursor database cannot be read: ${path}`); }
    finally { await messages.return(undefined); }
  }
  const hermesPath = join(process.env.HERMES_HOME || join(home, '.hermes'), 'state.db');
  if (existsSync(hermesPath)) {
    const database = new Database(hermesPath, { readonly: true });
    try {
      for (const session of database.query('SELECT id, cwd FROM sessions ORDER BY started_at, id').all() as Array<{ id: string; cwd: string | null }>) {
        const cwd = session.cwd || '';
        if (cwd && isProjectExcluded(cwd, excluded)) continue;
        yield { id: session.id, platform: 'hermes', project: projectFor(cwd, 'hermes-history'), path: hermesPath, cwd, events: () => sanitizeEvents((async function* () {
          for (const row of database.query('SELECT role, content, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY id').iterate(session.id) as Iterable<{ role: string; content: string | null; tool_calls: string | null; timestamp: number }>) {
            if (!['user', 'assistant', 'tool'].includes(row.role)) continue;
            const at = sourceTimestamp(row.timestamp);
            yield { role: row.role, text: [row.content, row.tool_calls].filter(Boolean).join('\n'), ...(at ? { at } : {}) };
          }
        })()) };
      }
    } finally { database.close(); }
  }
  const codeHome = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Code') : join(home, '.config', 'Code');
  for (const path of files(join(codeHome, 'User', 'workspaceStorage'), path => /\/chatSessions\/[^/]+\.json$/.test(path))) {
    if (excluded) { report(`No project identity for exclusion checks: ${path}`); continue; }
    if (statSync(path).size > 64 * 1024 * 1024) { report(`VS Code JSON exceeds the safe reader limit: ${path}`); continue; }
    let session;
    try { session = JSON.parse(readFileSync(path, 'utf8')); }
    catch { report(`Unreadable VS Code JSON: ${path}`); continue; }
    if (!Array.isArray(session.requests)) { report(`Unsupported VS Code session: ${path}`); continue; }
    yield { id: session.sessionId || basename(path), platform: 'copilot', project: 'vscode-history', path, cwd: '', events: () => sanitizeEvents((async function* () {
      for (const request of session.requests) {
        const at = sourceTimestamp(request.timestamp);
        yield { role: 'user', text: historicalText(request.message), ...(at ? { at } : {}) };
        yield { role: 'assistant', text: historicalText(request.response), ...(at ? { at } : {}) };
      }
    })()) };
  }
  for (const path of files(join(home, '.gemini', 'antigravity-cli', 'brain'), path => path.endsWith('.md'))) {
    if (excluded) { report(`No project identity for exclusion checks: ${path}`); continue; }
    if (statSync(path).size > 16 * 1024 * 1024) { report(`Antigravity note exceeds the safe reader limit: ${path}`); continue; }
    yield { id: path.slice(home.length), platform: 'antigravity-cli', project: 'antigravity-history', path, cwd: '', events: () => sanitizeEvents((async function* () {
      yield { role: 'assistant', text: redactHistoricalText(readFileSync(path, 'utf8')) };
    })()) };
  }
  if (existsSync(join(home, '.gemini', 'antigravity-cli', 'conversations'))) report('Antigravity binary trajectories are not decoded; retained Markdown notes are included.');
  if ([...files(join(codeHome, 'User', 'workspaceStorage'), path => /\/chatSessions\/[^/]+\.jsonl$/.test(path))].length) report('VS Code patch-journal sessions are not decoded; complete JSON sessions are included.');
}
