# Loopr customer-configurable exports — Stage 2

This learning project extends the Stage 1 TypeScript CSV exporter with a minimal NestJS HTTP API and MongoDB persistence. It is not the complete assignment. The original framework-independent exporter, sample JSON, configurations, CLI, and business-rule tests remain available.

## Model and architecture

A tenant has workspaces; workspaces contain inspection sessions and records. The 12 sample records have tenant, workspace, session and record IDs, a timestamp, result, confidence and optional image URL. Names can overlap across tenants.

NestJS supplies the HTTP controller, DTO validation, dependency wiring, and application lifecycle. MongoDB replaces JSON as the API's runtime data source and persists both `inspections` and `export_jobs` across application restarts; the JSON file remains the seed source and supports the Stage 1 CLI. The seed uses an upsert by inspection ID, so it can be rerun without duplicating records.

For `POST /exports`, Nest validates the DTO, creates a PENDING job, marks it PROCESSING, queries inspections using both tenant and workspace, and passes them to the existing CSV functions. Those functions apply the optional result filter, choose the requested columns in order, escape CSV, and neutralize formula-like string values. The service writes a job-ID-named file in `output/` and marks the job COMPLETED, or records FAILED with a safe error message. Jobs store tenant and workspace IDs, the request configuration, status, optional output path or error, creation time, and completion time. MongoDB's `_id` is exposed as `id`.

Exports run **synchronously during the HTTP request** and all selected records are loaded into memory. This is unsuitable for large datasets. A database outage can prevent a status update; there is no crash recovery. A completed job also depends on its local output file remaining available.

## Start locally

Requirements: Node.js 20 or newer, npm, and Docker with Compose (or an existing MongoDB instance).

```sh
npm install
cp .env.example .env
docker compose up -d
npm run seed
npm run start
```

The seed can be run repeatedly. MongoDB data is kept in a Docker volume. The default MongoDB URI and port are in `.env.example`; set `MONGODB_URI` and `PORT` in `.env` as needed. Run commands from the project root so data and output paths resolve correctly.

## Use the API

In another terminal, create an export (the sample workspace is `assembly`):

```sh
curl -sS -X POST http://localhost:3000/exports \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"tenant-a","workspaceId":"assembly","fields":["id","result","timestamp"],"filters":{"result":"FAIL"}}'
```

The response is similar to `{"id":"507f1f77bcf86cd799439011","status":"COMPLETED"}`. Copy its ID into the following commands:

```sh
JOB_ID=507f1f77bcf86cd799439011
curl -sS "http://localhost:3000/exports/$JOB_ID"
curl -fS "http://localhost:3000/exports/$JOB_ID/download" -o export.csv
```

A missing job or missing file returns 404; a job that is not completed returns 409. Unknown request properties, invalid fields, duplicate fields, invalid filters, and non-string tenant/workspace identifiers return 400. Filenames are generated internally; download paths are derived from a validated job ID.

Run both the Jest service/validation tests and the original Stage 1 Node tests:

```sh
npm test
```

The original CLI remains available with `npm run export -- config/customer-a.json` (or `config/customer-b.json`). It reads JSON directly and does not create a database job.

## Security and deferred work

Tenant and workspace are included in every inspection query, and DTO validation rejects object-valued IDs that could act as MongoDB operators. CSV escaping handles commas, quotes and newlines; missing values are empty. Formula-like strings are prefixed with an apostrophe, including after leading whitespace or control characters.

**This is not secure multi-tenant authentication.** Anyone who can reach this API can supply a tenant ID or access a job ID. Production must derive tenant identity from an authenticated authorization context and authorize job lookup and downloads.

There are no background workers, retries, crash recovery, scheduling, large-dataset streaming, real tenant authentication, S3/object storage, or ERP integration. These belong to later stages, not this implementation.
