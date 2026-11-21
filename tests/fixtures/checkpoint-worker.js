require("reflect-metadata");
const mongoose = require("mongoose");
const {
  Inspection,
  InspectionSchema,
} = require("../../dist/src/inspections/inspection.schema");
const {
  InspectionsService,
} = require("../../dist/src/inspections/inspections.service");
const {
  ExportJob,
  ExportJobSchema,
} = require("../../dist/src/exports/export-job.schema");
const {
  ExportsProcessor,
} = require("../../dist/src/exports/exports.processor");
(async () => {
  await mongoose.connect(process.env.TEST_MONGODB_URI);
  const jobs = mongoose.model(ExportJob.name, ExportJobSchema);
  const inspections = mongoose.model(Inspection.name, InspectionSchema);
  const processor = new ExportsProcessor(
    jobs,
    new InspectionsService(inspections),
  );
  processor.outputDir = process.env.TEST_OUTPUT_DIR;
  if (process.env.TEST_INTERRUPT === "1")
    processor.testHook = async (point) => {
      if (point === "afterWrite") {
        process.send({ point });
        await new Promise(() => {});
      }
    };
  await processor.process({
    data: { exportJobId: process.env.TEST_JOB_ID },
    attemptsMade: Number(process.env.TEST_ATTEMPT || 0),
    opts: { attempts: 3 },
  });
  await mongoose.disconnect();
  process.send({ done: true });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  mongoose.disconnect();
});
