# Submission summary

## Implemented

- Shared NestJS API with MongoDB inspection/job persistence and BullMQ/Redis background processing.
- Customer-specific CSV fields and filters, tenant/workspace isolation, CSV escaping and formula-injection protection.
- Bounded keyset batches, upper-bound capture, immutable per-job configuration snapshot, byte-offset checkpoints, partial-file truncation, checksum-verified finalization and local crash recovery.
- Immutable configuration version definitions keyed by tenant/config ID/revision, per-job snapshots, and distinct `outputSchemaVersion`; omitted legacy values resolve to version 1.
- MongoDB/Redis local setup, seed data, API examples, Stage 1–4 tests and a separate-process worker interruption test.

## Scenario selection

The working end-to-end scenario is asynchronous CSV export to local disk. The Stage 1 customer JSON configs demonstrate two customer-specific exports. Image-to-S3, scheduled CSV generation and ERP delivery are **design proposals only** in `docs/DESIGN.md`; no integrations or scheduler were built.

## Reliability demonstration

Tests cover batch boundaries, tenant/workspace filters, an upper bound excluding later higher IDs, interrupted writes before/after checkpoints, missing or short partial files, final rename recovery and a killed worker restarted against MongoDB. The implementation aims to avoid duplicated output rows under its stated single-writer and append-only ID assumptions. It does not promise exactly-once execution, true snapshot isolation or distributed durability.

## Scope and next priorities

The scope stays focused on the assignment's working CSV workflow and an understandable design for future destinations. Before production, prioritize authentication and per-job tenant authorization, enforced sortable IDs or stronger snapshots, durable shared storage and fencing, queue/database reconciliation, resource quotas and operational monitoring. Then implement one destination connector with its own integration tests.

## Development time

**7 hours**
