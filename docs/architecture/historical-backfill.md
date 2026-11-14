# Explicit historical memory backfill

This fork has a separate, manually started historical-memory workflow. It does
not replay the local observer queue. No service, timer, login, quota reset or
successful live save starts or resumes it.

## Source coverage

The scanner has no date filter. It reads retained evidence, not deleted history:

- Claude Code: project JSONL files, including subagent files.
- Codex: native session and archived-session response items. Duplicate UI event
  messages, system instructions and developer instructions are not imported.
- Cursor: agent-transcript JSONL files. For sessions without those files, JSON
  message blobs in the chat database are read as **unordered evidence**. Binary
  blobs are not decoded. The reducer must not infer chronology from blob order.
- Hermes: the native `state.db` sessions and messages, opened read-only.
- VS Code: complete JSON chat sessions. Patch-journal JSONL sessions are not
  decoded by this version.
- Antigravity CLI: retained Markdown notes in its `brain` directory. Its binary
  conversation trajectories are not decoded by this version. Notes do not
  establish that a complete original transcript was retained.

The scanner reports unsupported formats and exclusion decisions on stderr.
It marks corrupt JSONL records as evidence gaps. After a gap, it excludes
messages until the next readable user prompt because the privacy boundary is
unknown. It preserves recorded source timestamps. Unreadable databases do not
prevent the other sources from being scanned.
Existing saved memories continue through normal saved-record synchronization;
this command does not regenerate them from the live inference queue.

GitHub Actions archives can be a source of retained Claude/Codex/Cursor JSONL,
but artifact retention limits recovery. An all-time request cannot recover
expired artifacts. Do not import configuration, authentication files or whole
agent-home debug dumps. Keep archive extraction path-safe and separate from
the native transcript roots. No GitHub polling service is installed here.

## Explicit reducer contract

1. `scan` makes private, immutable normalized snapshots and a catalog. It makes
   no model calls. Original files and databases are not modified.
2. `run` uses `gpt-6-luna`, low reasoning, Standard speed, through an existing
   Codex ChatGPT login. It does not select an API key or change live observer
   settings. Codex plugins, hooks, shell tools, apps, web search and project
   instructions are disabled. Requests are ephemeral and use a read-only
   sandbox in a private temporary directory.
3. Each request takes a source position, the compact reducer state from the
   preceding completed chunk, and bounded source evidence. A source hash
   protects the position/state pair. This is a stateless historical reducer,
   not a reconstructed live observer conversation.
4. The journal records a request before dispatch. It saves the validated model
   result before writing memories. Each memory has a stable source fingerprint,
   so a failed save can be delivered again without duplicate records or another
   model request. A successful save must receive an explicit acknowledgment.
5. A model, quota, authentication, network or validation failure stops the run.
   There is no automatic retry. A request without a durable result is uncertain.
   It requires a separately approved `--retry-uncertain` before another model
   call. A restart does not erase that requirement.
6. `--continue` is always explicit. It is required after any prior invocation,
   including a time or call limit. A continuation resends durable generated
   output without another model call. It does not bypass an uncertain request.

The journal is not a startup queue and has no worker-side drain. It lives under
`~/.claude-mem/history-backfill`, separate from live capture and `sync_outbox`.
Snapshots and the journal are private. Raw evidence can contain sensitive data;
redaction is not a guarantee that all possible secrets have been identified.
Private turns are excluded. Private Cursor fragments exclude the whole database
because their chronological boundaries cannot be established. Sources without
a project identity are excluded when project-exclusion rules are configured.

Generated observations carry historical/source/model metadata. Their database
creation time is the import time, not a claim about the original session time.
Original transcripts remain the authoritative evidence. The reducer must
distinguish plans from confirmed work and may produce no memory for a chunk.

## Commands

Build the root bundles on the build host before installation. Use Bun 1.4.4
and Python 3 (standard-library SQLite; no Python packages are required).
Run the tested
`plugin/scripts/history-backfill.cjs` bundle under Bun. For remote scanning,
place that same bundle at
`~/.local/share/claude-mem-fork/history-backfill.cjs` on each source host.
The coordinator uses SSH aliases and never copies model authentication files.

```sh
bun plugin/scripts/history-backfill.cjs scan \
  --source-host local --source-host nas --source-host justin-personal

bun plugin/scripts/history-backfill.cjs run \
  --worker-url http://127.0.0.1:37701 --max-calls 100 --seconds 480

bun plugin/scripts/history-backfill.cjs run --continue \
  --worker-url http://127.0.0.1:37701 --max-calls 100 --seconds 480
```

The default call limit is 100. `--max-calls 0` removes the total call limit for
that invocation; it does not bypass quota, authentication or uncertainty stops.
Each segment has a maximum wall-clock budget of 480 seconds. No unattended
continuation is configured by default. An explicitly approved long job can use
`run --until-stop --max-calls 0`: it continues across time-limited segments in
that one process, but exits on the first error and has no restart policy.
The coordinator writes through its loopback worker;
normal saved-record synchronization distributes the memories to other devices.

A new scan requires a new `--directory`. It does not overwrite an existing
catalog or change the source under a checkpoint. Preserve a failed journal
until the request outcome has been reviewed. Do not delete it merely to obtain
a fresh paid-send attempt.
