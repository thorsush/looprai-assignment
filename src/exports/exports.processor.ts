import { Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectModel } from "@nestjs/mongoose";
import { Job, UnrecoverableError } from "bullmq";
import { Model } from "mongoose";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCsv } from "../exporter";
import { InspectionsService } from "../inspections/inspections.service";
import { ExportJob } from "./export-job.schema";

async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path))
    digest.update(chunk as Buffer);
  return digest.digest("hex");
}

// Test hooks are never supplied by HTTP; tests can override this method on an instance.
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

type FailurePoint =
  | "beforeBatch"
  | "afterWrite"
  | "afterCheckpoint"
  | "afterRename";

@Processor("exports", { concurrency: 1 })
export class ExportsProcessor extends WorkerHost {
  private readonly outputDir = resolve("output");
  constructor(
    @InjectModel(ExportJob.name) private readonly jobs: Model<ExportJob>,
    private readonly inspections: InspectionsService,
  ) {
    super();
  }
  protected async testHook(_point: FailurePoint): Promise<void> {}

  async process(queueJob: Job<{ exportJobId: string }>): Promise<void> {
    const id = queueJob.data.exportJobId;
    if (!/^[a-f\d]{24}$/.test(id))
      throw new UnrecoverableError("Invalid export job ID");
    const finalPath = join(this.outputDir, `${id}.csv`);
    const partialPath = join(this.outputDir, `${id}.part`);
    const existing = await this.jobs.findById(id).lean().exec();
    if (!existing) throw new UnrecoverableError("Export job not found");
    if (existing.status === "FAILED") return;
    if (existing.status === "COMPLETED") {
      if (
        !existing.outputHash ||
        (await stat(finalPath).catch(() => null))?.size !==
          existing.outputOffsetBytes ||
        (await fileHash(finalPath)) !== existing.outputHash
      )
        throw new UnrecoverableError("Completed export file is inconsistent");
      return;
    }
    const runId = randomUUID();
    const attempt = queueJob.attemptsMade + 1;
    const claimed = await this.jobs
      .findOneAndUpdate(
        { _id: id, status: { $in: ["QUEUED", "PROCESSING"] } },
        {
          $set: {
            status: "PROCESSING",
            activeRunId: runId,
            attemptCount: attempt,
            error: null,
            startedAt: existing.startedAt || new Date(),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!claimed) return;
    const guard = { _id: id, status: "PROCESSING", activeRunId: runId };
    const checkpoint = async (data: Record<string, unknown>) => {
      const updated = await this.jobs.updateOne(guard, {
        $set: data,
        $inc: { checkpointVersion: 1 },
      });
      if (!updated.matchedCount) throw new Error("Worker no longer owns job");
      Object.assign(claimed, data);
    };
    try {
      await mkdir(this.outputDir, { recursive: true });
      const finalInfo = await stat(finalPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (finalInfo) {
        if (
          !claimed.finalizing ||
          !claimed.outputHash ||
          finalInfo.size !== claimed.outputOffsetBytes ||
          (await fileHash(finalPath)) !== claimed.outputHash
        )
          throw new UnrecoverableError("Existing export file is inconsistent");
        await syncDirectory(this.outputDir);
        await checkpoint({
          status: "COMPLETED",
          progress: 100,
          outputPath: `output/${id}.csv`,
          completedAt: new Date(),
          error: null,
        });
        return;
      }
      if (claimed.finalizing) {
        // The rename may not have happened yet; the partial file is still checked below.
        if (!claimed.outputHash)
          throw new UnrecoverableError("Finalization metadata is incomplete");
      }
      if (!claimed.snapshotInitialized) {
        const configuredSize = Number(process.env.EXPORT_BATCH_SIZE || 1000);
        if (
          !Number.isSafeInteger(configuredSize) ||
          configuredSize < 1 ||
          configuredSize > 100000
        )
          throw new UnrecoverableError("Invalid export batch size");
        const upperBoundId = await this.inspections.upperBound(
          claimed.tenantId,
          claimed.workspaceId,
          claimed.config.filters?.result,
        );
        const totalRecords =
          upperBoundId === null
            ? 0
            : await this.inspections.countTo(
                claimed.tenantId,
                claimed.workspaceId,
                upperBoundId,
                claimed.config.filters?.result,
              );
        await checkpoint({
          upperBoundId,
          totalRecords,
          batchSize: configuredSize,
          snapshotInitialized: true,
          outputOffsetBytes: 0,
          processedRecords: 0,
          lastProcessedId: null,
          progress: 0,
        });
      }
      const offset = claimed.outputOffsetBytes || 0;
      let handle;
      try {
        handle = await open(partialPath, offset === 0 ? "a+" : "r+");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && offset > 0)
          throw new UnrecoverableError("Checkpoint file is missing");
        throw error;
      }
      try {
        const size = (await handle.stat()).size;
        if (size < offset)
          throw new UnrecoverableError(
            "Checkpoint file is shorter than its committed offset",
          );
        if (size > offset) {
          await handle.truncate(offset);
          await handle.sync();
        }
        const config = {
          tenantId: claimed.tenantId,
          workspaceId: claimed.workspaceId,
          fields: claimed.config.fields,
          resultFilter: claimed.config.filters?.result,
          outputFilename: `${id}.csv`,
        };
        let position = offset;
        if (position === 0) {
          const header = Buffer.from(createCsv([], config));
          await handle.writeFile(header);
          await handle.sync();
          position = header.length;
          await checkpoint({ outputOffsetBytes: position });
        }
        while (claimed.upperBoundId !== null) {
          const batch = await this.inspections.nextBatch(
            claimed.tenantId,
            claimed.workspaceId,
            claimed.upperBoundId,
            claimed.lastProcessedId,
            claimed.batchSize,
            claimed.config.filters?.result,
          );
          if (!batch.length) break;
          await this.testHook("beforeBatch");
          const csv = createCsv(batch, config);
          const rows = Buffer.from(csv.slice(csv.indexOf("\r\n") + 2));
          // Explicit positional writes handle short writes without accumulating the full export.
          let written = 0;
          while (written < rows.length) {
            const result = await handle.write(
              rows,
              written,
              rows.length - written,
              position + written,
            );
            if (!result.bytesWritten) throw new Error("Unable to write CSV");
            written += result.bytesWritten;
          }
          await handle.sync();
          await this.testHook("afterWrite");
          position += rows.length;
          const processedRecords = claimed.processedRecords + batch.length;
          await checkpoint({
            lastProcessedId: batch[batch.length - 1].id,
            processedRecords,
            outputOffsetBytes: position,
            progress: claimed.totalRecords
              ? Math.floor((processedRecords * 100) / claimed.totalRecords)
              : 0,
          });
          await this.testHook("afterCheckpoint");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      const digest = await fileHash(partialPath);
      if (claimed.finalizing && claimed.outputHash !== digest)
        throw new UnrecoverableError("Finalizing partial file is inconsistent");
      await checkpoint({ outputHash: digest, finalizing: true });
      await rename(partialPath, finalPath);
      // Directory fsync is unsupported on some platforms; failure is surfaced rather than claiming durable publication.
      await syncDirectory(this.outputDir);
      await this.testHook("afterRename");
      await checkpoint({
        status: "COMPLETED",
        progress: 100,
        outputPath: `output/${id}.csv`,
        completedAt: new Date(),
        error: null,
      });
    } catch (error) {
      const unrecoverable = error instanceof UnrecoverableError;
      const exhausted =
        unrecoverable || attempt >= (queueJob.opts.attempts ?? 1);
      await this.jobs.updateOne(guard, {
        $set: {
          status: exhausted ? "FAILED" : "QUEUED",
          error: unrecoverable
            ? "Export cannot be recovered: checkpoint or output is inconsistent"
            : exhausted
              ? "Export failed"
              : "Export attempt failed; retry pending",
          ...(exhausted ? { completedAt: new Date() } : {}),
        },
        $unset: { activeRunId: 1 },
      });
      throw error;
    }
  }
}
