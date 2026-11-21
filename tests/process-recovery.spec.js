require("reflect-metadata");
const mongoose = require("mongoose");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, rm, readFile, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  Inspection,
  InspectionSchema,
} = require("../dist/src/inspections/inspection.schema");
const {
  ExportJob,
  ExportJobSchema,
} = require("../dist/src/exports/export-job.schema");

const run = process.env.TEST_MONGODB_URI ? test : test.skip;
run(
  "a killed worker resumes from a real MongoDB checkpoint",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-recovery-"));
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    const inspections = mongoose.model(Inspection.name, InspectionSchema);
    const jobs = mongoose.model(ExportJob.name, ExportJobSchema);
    const tenantId = `test-${new mongoose.Types.ObjectId()}`;
    const records = Array.from({ length: 8 }, (_, i) => ({
      id: `${tenantId}-${String(i).padStart(3, "0")}`,
      tenantId,
      workspaceId: "w",
      sessionId: "s",
      timestamp: "t",
      result: "PASS",
      confidence: 1,
    }));
    let created;
    try {
      await inspections.insertMany(records);
      created = await jobs.create({
        tenantId,
        workspaceId: "w",
        config: { configId: "restart-test", version: 1, type: "csv", outputSchemaVersion: 1, tenantId, workspaceId: "w", fields: ["id", "result"] },
        configId: "restart-test", configVersion: 1, outputSchemaVersion: 1,
        status: "QUEUED",
      });
      const env = {
        ...process.env,
        EXPORT_BATCH_SIZE: "3",
        TEST_JOB_ID: created.id,
        TEST_OUTPUT_DIR: dir,
      };
      const child = fork(join(__dirname, "fixtures/checkpoint-worker.js"), {
        env: { ...env, TEST_INTERRUPT: "1" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      await once(child, "message");
      child.kill("SIGKILL");
      await once(child, "exit");
      const before = await jobs.findById(created.id).lean();
      console.log("Checkpoint before restart:", {
        lastProcessedId: before.lastProcessedId,
        processedRecords: before.processedRecords,
        outputOffsetBytes: before.outputOffsetBytes,
        upperBoundId: before.upperBoundId,
      });
      expect(before.processedRecords).toBe(0);
      expect(
        (await stat(join(dir, `${created.id}.part`))).size,
      ).toBeGreaterThan(before.outputOffsetBytes);
      const resumed = fork(join(__dirname, "fixtures/checkpoint-worker.js"), {
        env: { ...env, TEST_ATTEMPT: "1" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const [message] = await once(resumed, "message");
      expect(message).toEqual({ done: true });
      const after = await jobs.findById(created.id).lean();
      console.log("Checkpoint after restart:", {
        lastProcessedId: after.lastProcessedId,
        processedRecords: after.processedRecords,
        outputOffsetBytes: after.outputOffsetBytes,
        upperBoundId: after.upperBoundId,
      });
      expect(after).toMatchObject({
        status: "COMPLETED",
        processedRecords: 8,
        attemptCount: 2,
      });
      const csv = await readFile(join(dir, `${created.id}.csv`), "utf8");
      expect(csv).toBe(
        "id,result\r\n" + records.map((r) => `${r.id},PASS\r\n`).join(""),
      );
    } finally {
      await inspections.deleteMany({ tenantId });
      if (created) await jobs.deleteOne({ _id: created._id });
      await mongoose.disconnect();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
