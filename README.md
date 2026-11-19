# Customer-configurable CSV exports — Phase 1

This small project lets each customer choose which inspection data to export as CSV. It demonstrates the core selection and formatting logic for a multi-tenant export system; it is **not a complete solution** to the larger assignment.

## Data model

The sample JSON contains 12 inspection records. A tenant has workspaces; each workspace has inspection sessions; each session has records. Every record carries its tenant, workspace, and session IDs, a timestamp, PASS/FAIL result, confidence, and an optional image URL. Workspace names may overlap across tenants, so both tenant and workspace must match.

## Configuration and flow

Each JSON configuration specifies `tenantId`, `workspaceId`, an ordered list of `fields`, an optional `resultFilter` (`PASS` or `FAIL`), and an `outputFilename`. See the two files in `config/`. Customer A exports failed assembly inspections; customer B exports packaging inspections with a different column order.

The CLI:

1. Reads and validates the configuration: required IDs, known and unique fields, valid optional filter, and a safe `.csv` basename.
2. Reads the inspection records from `data/inspections.json`.
3. Selects records matching both tenant and workspace, then applies the optional result filter.
4. Writes the requested columns in order, including a header, to `output/`.

CSV cells containing commas, quotes, or line breaks are quoted, and quotes are doubled. Missing optional values become empty cells. String values that begin with a spreadsheet formula marker (`=`, `+`, `-`, or `@`), including after leading whitespace or control characters, are prefixed with an apostrophe. Numbers remain numeric text. Empty exports contain the header only.

## Run

Use Node.js 20 or later and npm, from the project root:

```sh
npm install
npm run export -- config/customer-a.json
npm run export -- config/customer-b.json
npm test
```

The files are written to `output/customer-a.csv` and `output/customer-b.csv`. Running an export again overwrites the file with the same name.

Customer A output:

```csv
id,timestamp,result,confidence
a-002,2026-01-10T09:01:00Z,FAIL,0.91
a-003,2026-01-11T09:00:00Z,FAIL,0.87
```

Customer B output:

```csv
sessionId,id,result,imageUrl
b-s1,b-001,PASS,https://example.com/b-001.jpg
b-s1,b-002,FAIL,
b-s2,b-003,PASS,https://example.com/b-003.jpg
b-s2,b-004,FAIL,
```

## Scope and limitations

Implemented: configuration validation, tenant and workspace selection, optional result filtering, ordered column selection, CSV escaping and spreadsheet formula protection, local file output, sample configurations, and automated tests.

This phase processes the entire trusted sample JSON dataset in memory; it does not validate individual input records or support large datasets. It has no authentication or authorization, database, scheduling, retries, checkpoints, crash recovery, queues, ERP API or S3/object-storage integration. Tenant filtering illustrates isolation in the export logic, but is not a substitute for an authenticated authorization boundary.

The larger assignment can build on this selection and formatting behavior while adding other destinations, reliable execution and recovery, and production-scale storage and security in later phases.
