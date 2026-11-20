# Loopr customer-configurable exports — Stage 3

This incremental learning project extends the Stage 1 CSV exporter and Stage 2 NestJS/MongoDB API with background export jobs using BullMQ and Redis. It is not the complete assignment.

## Architecture and lifecycle

A tenant has workspaces; each workspace has sessions and inspection records. The sample JSON contains 12 records. The seed upserts them into MongoDB by record ID. JSON remains available for the original Stage 1 CLI.

1. `POST /exports` validates the request, creates a MongoDB job with `QUEUED` status, and submits its MongoDB ID to the Redis-backed BullMQ queue. It returns HTTP 202 without waiting for the CSV.
2. The BullMQ processor in the same NestJS process picks up the job, sets `PROCESSING`, and reads inspection records scoped to both tenant and workspace. The existing framework-independent exporter filters results, selects columns and escapes CSV.
3. The processor updates the MongoDB counts and percentage in batches of two selected records. It writes a unique temporary file, records its SHA-256 checksum, then atomically renames the file to `output/<job-id>.csv` on the same filesystem. Only then does it mark the job `COMPLETED`.
4. Clients poll `GET /exports/:id` and use `GET /exports/:id/download` once complete. Failed or unfinished downloads return 409; a missing job or output file returns 404.

MongoDB stores the configuration, status, counts, attempt count, timestamps and safe errors. Redis stores BullMQ queue state, schedules retries and coordinates workers; it is not the source of truth for the API's job details. The controller handles HTTP, the service creates and retrieves jobs, and the processor performs exports. Three attempts are configured with exponential backoff starting at two seconds and worker concurrency two. Completed queue entries are retained for one day and failures for seven days (BullMQ removes aged entries lazily).

Progress counts **selected records** processed into the in-memory CSV, after the result filter. A value of 100 does not guarantee that the file is published or durable; check `COMPLETED`. With this small dataset a job may complete before polling observes intermediate percentages.

## Run locally

Requirements: Node.js 20+, npm and Docker Compose. From the project root:

```sh
npm install
cp .env.example .env
docker compose up -d
npm run seed
npm run start
```

The seed is safe to repeat. MongoDB uses a Docker volume. Redis connection settings and the server port are in `.env`. The API and worker use the same local `output/` directory and must share it if separated into processes.

Create an export (the sample workspace is `assembly`):

```sh
curl -sS -X POST http://localhost:3000/exports \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"tenant-a","workspaceId":"assembly","fields":["id","result","timestamp"],"filters":{"result":"FAIL"}}'
```

Copy the returned `id` into the following commands:

```sh
JOB_ID=replace-with-returned-id
curl -sS "http://localhost:3000/exports/$JOB_ID"
curl -fS "http://localhost:3000/exports/$JOB_ID/download" -o export.csv
```

To observe an automatic retry, run in development mode (do not set `NODE_ENV=production`):

```sh
curl -sS -X POST http://localhost:3000/exports \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"tenant-a","workspaceId":"assembly","fields":["id","result"],"simulateFailure":true}'
```

Poll its ID as above. The first attempt fails deterministically; after the two-second backoff the second succeeds. In production, requests specifying `simulateFailure` are rejected and the processor ignores it.

```sh
npm test
npm run export -- config/customer-a.json
```

The first command runs Jest job tests and the preserved Stage 1 Node tests. The second runs the original standalone JSON-based CLI without creating a database job.

## Reliability and boundaries

BullMQ is **at least once**, not exactly once. Attempts write separate temporary files rather than appending. A checksum stored before the atomic rename lets a retry verify and finalize a published file after a crash; the completed file is never marked complete before publication. Attempt IDs guard MongoDB updates so an old failure cannot overwrite a completed job. Temporary files are removed on normal completion or caught errors; an abrupt process termination may leave orphaned temporary files that require manual cleanup. A local file and rename do not provide distributed durability, and simultaneous stalled executions can still race over the final path: this is not a full fencing protocol.

MongoDB and Redis do not share a transaction. An enqueue error records a safe failure and returns 503, but a crash between MongoDB creation and enqueue can leave a `QUEUED` record with no queue entry. A network error can also make enqueue outcome ambiguous. There is no transactional outbox or automatic reconciliation in this stage. If MongoDB is unavailable during error handling, the job status may be stale. Redis and local-file persistence depend on the local environment; Compose's Redis is for development, not durable production setup.

CSV escapes commas, quotes and line breaks, uses empty cells for missing values, and prefixes formula-like strings with an apostrophe. Tenant and workspace are both included in every inspection query. **Caller-supplied tenant IDs are not authentication**: job lookup and download are also unauthenticated. Production must derive tenant identity from authenticated authorization context and enforce access to each job.

The prototype loads records and CSV into memory. It has no scheduling, streaming for large datasets, S3, ERP integration, or separate deployable workers. Stage 4 may improve checkpointing, crash recovery and distributed durability; those capabilities are not implemented here.
