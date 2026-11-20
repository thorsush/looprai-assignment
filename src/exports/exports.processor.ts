import { Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectModel } from "@nestjs/mongoose";
import { Job } from "bullmq";
import { Model } from "mongoose";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCsv, selectRecords } from "../exporter";
import { InspectionsService } from "../inspections/inspections.service";
import { ExportJob } from "./export-job.schema";

const hash = (contents: Buffer | string) =>
  createHash("sha256").update(contents).digest("hex");

@Processor("exports", { concurrency: 2 })
export class ExportsProcessor extends WorkerHost {
  private readonly outputDir = resolve("output");
  constructor(
    @InjectModel(ExportJob.name) private readonly jobs: Model<ExportJob>,
    private readonly inspections: InspectionsService,
  ) {
    super();
  }

  async process(queueJob: Job<{ exportJobId: string }>): Promise<void> {
    const id = queueJob.data.exportJobId;
    if (!/^[a-f\d]{24}$/.test(id)) throw new Error("Invalid export job ID");
    const existing = await this.jobs.findById(id).lean().exec();
    if (!existing) throw new Error("Export job not found");
    const finalPath = join(this.outputDir, `${id}.csv`);
    if (existing.status === "COMPLETED") {
      const published = await readFile(finalPath).catch(() => undefined);
      if (
        published &&
        existing.outputHash &&
        hash(published) === existing.outputHash
      )
        return;
      await this.jobs.updateOne(
        { _id: id, status: "COMPLETED" },
        {
          $set: {
            status: "FAILED",
            error: "Export file unavailable or invalid",
            completedAt: new Date(),
          },
          $unset: { outputPath: 1 },
        },
      );
      throw new Error("Export file unavailable or invalid");
    }
    if (existing.status === "FAILED") return;
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
            startedAt: new Date(),
            error: null,
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!claimed) return;
    const guard = { _id: id, status: "PROCESSING", activeRunId: runId };
    const tempPath = join(this.outputDir, `${id}.${runId}.tmp`);
    try {
      await mkdir(this.outputDir, { recursive: true });
      // A checksum stored before rename distinguishes a complete published file from an unrelated file.
      if (claimed.outputHash) {
        const previous = await readFile(finalPath).catch(() => undefined);
        if (previous && hash(previous) === claimed.outputHash) {
          await this.jobs.updateOne(guard, {
            $set: {
              status: "COMPLETED",
              progress: 100,
              outputPath: `output/${id}.csv`,
              completedAt: new Date(),
              error: null,
            },
            $unset: { activeRunId: 1 },
          });
          return;
        }
      }
      const config = claimed.config;
      const records = await this.inspections.findForWorkspace(
        claimed.tenantId,
        claimed.workspaceId,
      );
      const csvConfig = {
        tenantId: claimed.tenantId,
        workspaceId: claimed.workspaceId,
        fields: config.fields,
        resultFilter: config.filters?.result,
        outputFilename: `${id}.csv`,
      };
      const selected = selectRecords(records, csvConfig);
      const total = selected.length;
      let csv = createCsv([], csvConfig);
      await this.jobs.updateOne(guard, {
        $set: { totalRecords: total, processedRecords: 0, progress: 0 },
        $unset: { outputHash: 1 },
      });
      for (let i = 0; i < total; i += 2) {
        const batch = selected.slice(i, i + 2);
        const batchCsv = createCsv(batch, csvConfig);
        csv += batchCsv.slice(batchCsv.indexOf("\r\n") + 2);
        const processed = i + batch.length;
        await this.jobs.updateOne(guard, {
          $set: {
            processedRecords: processed,
            progress: Math.floor((processed * 100) / total),
          },
        });
        if (
          config.simulateFailure &&
          process.env.NODE_ENV !== "production" &&
          attempt === 1
        )
          throw new Error("Simulated failure");
      }
      if (
        config.simulateFailure &&
        process.env.NODE_ENV !== "production" &&
        attempt === 1
      )
        throw new Error("Simulated failure");
      await writeFile(tempPath, csv, "utf8");
      const prepared = await this.jobs.updateOne(guard, {
        $set: { outputHash: hash(csv) },
      });
      if (!prepared.matchedCount) return;
      await rename(tempPath, finalPath);
      await this.jobs.updateOne(guard, {
        $set: {
          status: "COMPLETED",
          progress: 100,
          outputPath: `output/${id}.csv`,
          completedAt: new Date(),
          error: null,
        },
        $unset: { activeRunId: 1 },
      });
    } catch (error) {
      const exhausted = attempt >= (queueJob.opts.attempts ?? 1);
      await this.jobs.updateOne(guard, {
        $set: {
          status: exhausted ? "FAILED" : "QUEUED",
          error: exhausted
            ? "Export failed"
            : "Export attempt failed; retry pending",
          ...(exhausted ? { completedAt: new Date() } : {}),
        },
        $unset: { activeRunId: 1 },
      });
      throw error;
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
