import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { InjectQueue } from "@nestjs/bullmq";
import { Model } from "mongoose";
import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { access } from "node:fs/promises";
import { createReadStream, ReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { CreateExportDto, resolveExportConfig } from "./dto/create-export.dto";
import { ExportJob } from "./export-job.schema";
import { ExportConfigVersion } from "./export-config-version.schema";

@Injectable()
export class ExportsService {
  private readonly outputDir = resolve("output");
  constructor(
    @InjectModel(ExportJob.name) private readonly jobs: Model<ExportJob>,
    @InjectQueue("exports") private readonly queue: Queue,
    @InjectModel(ExportConfigVersion.name) private readonly configVersions: Model<ExportConfigVersion>,
  ) {}

  async create(config: CreateExportDto) {
    const requestedSnapshot = resolveExportConfig(config);
    const fingerprint = createHash("sha256").update(JSON.stringify(requestedSnapshot)).digest("hex");
    const key = { tenantId: requestedSnapshot.tenantId, configId: requestedSnapshot.configId, version: requestedSnapshot.version };
    let definition;
    try {
      definition = await this.configVersions.findOneAndUpdate(
        key,
        { $setOnInsert: { ...key, outputSchemaVersion: requestedSnapshot.outputSchemaVersion, config: requestedSnapshot, fingerprint, createdAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean().exec();
    } catch (error) {
      // Concurrent first use may race on the unique version key; read the winner below.
      if ((error as { code?: number }).code !== 11000) throw error;
      definition = await this.configVersions.findOne(key).lean().exec();
    }
    if (!definition || definition.fingerprint !== fingerprint) {
      throw new ConflictException("Configuration version is immutable; submit a new version");
    }
    const snapshot = definition.config as ReturnType<typeof resolveExportConfig>;
    const job = await this.jobs.create({
      tenantId: snapshot.tenantId,
      workspaceId: snapshot.workspaceId,
      config: snapshot,
      configId: snapshot.configId,
      configVersion: snapshot.version,
      outputSchemaVersion: snapshot.outputSchemaVersion,
      status: "QUEUED",
    });
    try {
      await this.queue.add(
        "export",
        { exportJobId: job.id },
        { jobId: job.id },
      );
    } catch {
      await this.jobs.updateOne(
        { _id: job.id, status: "QUEUED" },
        {
          $set: {
            status: "FAILED",
            error: "Could not enqueue export",
            completedAt: new Date(),
          },
        },
      );
      throw new ServiceUnavailableException("Could not enqueue export");
    }
    return { id: job.id, status: "QUEUED" };
  }

  async findOne(id: string) {
    if (!/^[a-f\d]{24}$/i.test(id))
      throw new NotFoundException("Export job not found");
    const job = await this.jobs.findById(id).lean().exec();
    if (!job) throw new NotFoundException("Export job not found");
    const { _id, activeRunId, outputHash, ...details } = job;
    return { id: String(_id), ...details };
  }

  async download(id: string): Promise<ReadStream> {
    const job = await this.findOne(id);
    if (job.status !== "COMPLETED")
      throw new ConflictException("Export is not available");
    try {
      const path = join(this.outputDir, `${id.toLowerCase()}.csv`);
      await access(path);
      return createReadStream(path);
    } catch {
      throw new NotFoundException("Export file not found");
    }
  }
}
