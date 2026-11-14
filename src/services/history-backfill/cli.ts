import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { completeLines } from './lines.js';
import { parseArgs } from 'node:util';
import { discoverHistoricalSources } from './sources.js';
import { HISTORICAL_MODEL, historicalHash, runHistoricalBackfill, type Snapshot } from './runner.js';

async function writeLine(value: unknown): Promise<void> {
  const buffer = Buffer.from(`${JSON.stringify(value)}\n`);
  let offset = 0;
  while (offset < buffer.length) {
    try { offset += writeSync(1, buffer, offset, buffer.length - offset); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
}

async function exportHistory(): Promise<void> {
  for await (const source of discoverHistoricalSources(homedir(), message => console.error(message))) {
    const { events, ...header } = source;
    await writeLine({ begin: header });
    const hasher = createHash('sha256');
    let count = 0;
    try {
      for await (const event of events()) { hasher.update(`${JSON.stringify(event)}\n`); count++; await writeLine({ event }); }
      await writeLine({ end: true, events: count, digest: hasher.digest('hex') });
    } catch {
      console.error(`Source could not be read completely: ${source.path}`);
      await writeLine({ end: true, failed: true });
    }
  }
}

async function scan(directory: string, hosts: string[]): Promise<void> {
  if (existsSync(join(directory, 'catalog.json'))) throw new Error('A snapshot catalog already exists. Use a new --directory for a new, explicit scan.');
  mkdirSync(join(directory, 'snapshots'), { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const catalog: Snapshot[] = [];
  for (const host of hosts) {
    if (host !== 'local' && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) throw new Error('Use an SSH host alias, not shell syntax');
    const args = host === 'local' ? [process.argv[1], 'export'] : ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'exec "$HOME/.bun/bin/bun" "$HOME/.local/share/claude-mem-fork/history-backfill.cjs" export'];
    const child = spawn(host === 'local' ? process.execPath : 'ssh', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Historical export failed on ${host} (${code})`)));
    });
    void exited.catch(() => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), 480000);
    let current: Omit<Snapshot, 'file' | 'digest' | 'events' | 'host'> | undefined;
    let output: ReturnType<typeof createWriteStream> | undefined;
    let temporary = '';
    let hasher = createHash('sha256');
    let events = 0;
    try {
      for await (const line of completeLines(child.stdout)) {
        const record = JSON.parse(line);
        if (record.begin) {
          if (current) throw new Error('Historical export source did not finish');
          current = record.begin;
          temporary = join(directory, 'snapshots', `${historicalHash(`${host}:${current!.platform}:${current!.id}`)}.tmp`);
          output = createWriteStream(temporary, { mode: 0o600 });
          hasher = createHash('sha256');
          events = 0;
        } else if (record.event && output) {
          const text = `${JSON.stringify(record.event)}\n`;
          hasher.update(text);
          if (!output.write(text)) await once(output, 'drain');
          events++;
        } else if (record.end && current && output) {
          output.end();
          await once(output, 'finish');
          const digest = hasher.digest('hex');
          if (!record.failed && (record.events !== events || record.digest !== digest)) throw new Error(`Historical transfer checksum failed on ${host}`);
          const file = join(directory, 'snapshots', `${digest}.jsonl`);
          if (record.failed) rmSync(temporary);
          else {
            renameSync(temporary, file);
            if (events) catalog.push({ ...current, file, digest, events, host });
          }
          current = undefined;
          output = undefined;
        } else throw new Error('Invalid historical export record');
      }
      await exited;
      if (current) throw new Error('Historical export ended inside a source');
      console.log(JSON.stringify({ scannedHost: host, totalSources: catalog.length }));
    } finally {
      clearTimeout(timer);
      child.kill();
      output?.destroy();
      if (temporary && existsSync(temporary)) rmSync(temporary);
    }
  }
  writeFileSync(join(directory, 'catalog.json.tmp'), JSON.stringify(catalog), { mode: 0o600 });
  renameSync(join(directory, 'catalog.json.tmp'), join(directory, 'catalog.json'));
  console.log(JSON.stringify({ sources: catalog.length, events: catalog.reduce((sum, source) => sum + source.events, 0), model: HISTORICAL_MODEL, generationStarted: false }));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { directory: { type: 'string' }, 'source-host': { type: 'string', multiple: true }, 'worker-url': { type: 'string' }, continue: { type: 'boolean' }, 'retry-uncertain': { type: 'boolean' }, 'until-stop': { type: 'boolean' }, seconds: { type: 'string' }, 'max-calls': { type: 'string' } }, strict: true });
  const directory = values.directory || join(homedir(), '.claude-mem', 'history-backfill');
  if (command === 'export') { await exportHistory(); return; }
  if (command === 'scan') { await scan(directory, values['source-host'] ?? ['local']); return; }
  if (command === 'run') {
    const seconds = Number(values.seconds ?? '480');
    const maxCalls = Number(values['max-calls'] ?? '100');
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 480 || !Number.isInteger(maxCalls) || maxCalls < 0) throw new Error('Use --seconds 1..480 and --max-calls 0 or a positive integer');
    if (values['until-stop'] && maxCalls !== 0) throw new Error('--until-stop requires --max-calls 0; it must not bypass a call limit');
    let continued = values.continue ?? false;
    do {
      const result = await runHistoricalBackfill({ directory, workerUrl: values['worker-url'] || 'http://127.0.0.1:37701', continued, retryUncertain: values['retry-uncertain'] ?? false, seconds, maxCalls, report: console.log });
      console.log(JSON.stringify(result));
      if (!values['until-stop'] || !result.timeLimited) break;
      continued = true;
    } while (true);
    return;
  }
  console.log('history-backfill scan [--source-host local --source-host nas --source-host justin-personal] [--directory PATH]\nhistory-backfill run [--continue] [--max-calls 100|0] [--seconds 480] [--until-stop] [--worker-url http://127.0.0.1:37701]\n--until-stop requires --max-calls 0 and continues only within this explicitly started job. No service, timer, or quota reset resumes a failed workflow. --retry-uncertain needs explicit approval.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Historical backfill failed'); process.exitCode = 1; });
