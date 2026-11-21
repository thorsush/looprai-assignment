# Loopr customer-configurable exports — Stage 4

This learning project extends the Stage 1 CSV logic, Stage 2 NestJS/MongoDB API and Stage 3 BullMQ queue with bounded batches, durable checkpoints and local crash recovery. It is not the complete assignment.

## Architecture

`POST /exports` validates a customer configuration, snapshots it in a MongoDB job and queues its ID in Redis/BullMQ; it returns HTTP 202. The worker reads inspections for that tenant and workspace, generates the CSV, and checkpoints each committed batch. `GET /exports/:id` exposes status and progress, and `GET /exports/:id/download` streams a completed file. The API and worker are in one NestJS process. Run **only one instance** of this application for Stage 4; worker concurrency is one. Redis schedules up to three attempts with exponential backoff starting at two seconds.

The sample JSON contains 12 records arranged as tenant → workspace → session → inspection; the seed upserts by inspection ID. The Stage 1 CLI and CSV functions remain available. Result filters, selected field order, CSV escaping and spreadsheet-formula protection are unchanged. Configuration is stored on the job, rather than read from a mutable customer configuration during processing.

## Batches and consistency

At the first attempt, the worker persists the largest matching inspection ID, a count, and `EXPORT_BATCH_SIZE` (default 1000) with the job. It queries each next batch by tenant, workspace, optional result, `id > lastProcessedId`, and `id <= upperBoundId`, sorted by `id` with MongoDB's simple binary collation. It does not use `skip`, whose work increases with the offset and whose pages shift when records are inserted. The inspection schema includes compound indexes for both filtered and unfiltered queries.

Sample IDs are unique immutable strings such as `a-001`; ordering is **binary lexicographic**, not numeric (`a-10` sorts before `a-2`). This stage assumes records are append-only, IDs are unique and immutable, and newly visible IDs for a tenant/workspace are always greater than earlier visible IDs. The fixtures illustrate ordering but do not enforce a production ID allocator. The upper bound excludes later higher IDs; it is **not snapshot isolation** if records change, are deleted, backfilled or become visible out of order. A production ingestion system must enforce the assumptions or use a stronger snapshot mechanism.

## Checkpoints and recovery

The job stores `upperBoundId`, `lastProcessedId`, `processedRecords`, `totalRecords`, `outputOffsetBytes`, `batchSize`, `checkpointVersion`, status, attempts and timestamps. An offset is a **byte count**, not a character count. Progress counts committed selected records; 100% alone does not mean the final file has been published.

The worker writes a header once into `output/<id>.part`. For each bounded batch it serializes only that batch using the existing CSV logic, writes all bytes, syncs the file, and only then saves the offset and last ID to MongoDB. On retry, a file longer than the saved offset is truncated to it and synced; the worker resumes after the saved ID. A missing or shorter file with a nonzero offset is an unrecoverable local-file error. This avoids silently skipping data.

For example, with `id,result` and batch size 3, the header is 11 bytes. Rows `a-001,PASS`, `a-002,FAIL`, and `a-003,FAIL` each occupy 12 bytes including CRLF. After committing them, the checkpoint is `lastProcessedId=a-003`, `processedRecords=3`, `outputOffsetBytes=47`. If `a-004` is written and synced but the worker dies before the next checkpoint, the file is 59 bytes while MongoDB still says 47. Recovery truncates it back to 47 and writes `a-004` again, resulting in one row for that ID.

After the last batch, the worker syncs the file, records a streaming SHA-256 hash and final offset, atomically renames it on the same filesystem to `output/<id>.csv`, syncs the containing directory, then marks the job `COMPLETED`. A retry after rename checks finalization metadata, size and hash before completing the job. Inconsistent final files are rejected. Directory sync is not supported by every filesystem or operating system; errors are surfaced instead of claiming successful durable publication. Existing Stage 3 jobs and files do not have Stage 4 offsets and should be completed or migrated before upgrading; this prototype does not migrate them.

The protocol assumes one active writer and a durable local filesystem. BullMQ is at least once: processing may repeat after a crash. Truncation and checkpointing aim to produce one copy of each record under the stated assumptions; they do not guarantee exactly-once execution. Queue locks do not fence a stale process after lock loss, and the filesystem is not a distributed durable store. Multiple app/worker instances or a delayed stale worker can violate the single-writer assumption.

## Local setup and APIs

Install Node.js 20+, npm and Docker Compose. From the project root:

```sh
npm install
cp .env.example .env
docker compose up -d
npm run seed
npm run start
```

For a small demonstration, set `EXPORT_BATCH_SIZE=3` in `.env` before starting. MongoDB uses a Docker volume. The seed can be repeated without duplicate records. Use a single app instance and keep its `output/` on the same persistent filesystem across restarts.

```sh
curl -sS -X POST http://localhost:3000/exports \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"tenant-a","workspaceId":"assembly","fields":["id","result"]}'
JOB_ID=replace-with-returned-id
curl -sS "http://localhost:3000/exports/$JOB_ID"
curl -fS "http://localhost:3000/exports/$JOB_ID/download" -o export.csv
```

The sample configuration exports four records in two batches at size 3. A missing job or output returns 404; an unfinished or failed job cannot be downloaded (409). The original standalone example remains available with `npm run export -- config/customer-a.json`.

## Tests and reproducible interruption

```sh
npm test
TEST_MONGODB_URI=mongodb://127.0.0.1:27017/looprai_recovery_test npm test
```

The first command runs unit tests and skips the MongoDB-dependent test if the variable is absent. The second also creates a temporary tenant and job in that database, launches a separate worker using batch size 3, waits until a batch has been synced but **before** its checkpoint is saved, sends SIGKILL, then starts a new worker process. It prints checkpoint state before and after recovery and verifies the final CSV has eight distinct records. Test records and temporary files are cleaned up. This is a real process interruption using MongoDB; it invokes the worker directly, rather than testing BullMQ lock-loss redelivery. Other crash points use deterministic in-process test hooks, not public request fields. The regular API path can be checked separately using the commands above with MongoDB and Redis running.

## Remaining limitations

MongoDB and Redis do not share a transaction. A crash between creating a MongoDB job and enqueueing it can leave a queued job without a queue entry; an enqueue error can have an ambiguous outcome. There is no outbox or automatic reconciliation. Data and checkpoints depend on local disk durability, and downloading relies on the same filesystem. There is no distributed fencing, database snapshot, scheduling, S3, ERP integration, or authentication. **Caller-supplied tenant IDs are not authorization**; production must derive tenant identity from an authenticated context and authorize job access. The `simulateFailure` request field from Stage 3 is no longer accepted; failure injection is test-only.
