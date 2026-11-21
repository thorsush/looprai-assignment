require("reflect-metadata");
const { validate } = require("class-validator");
const { plainToInstance } = require("class-transformer");
const { mkdtemp, rm, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  CreateExportDto,
} = require("../dist/src/exports/dto/create-export.dto");
const { ExportsService } = require("../dist/src/exports/exports.service");
const {
  InspectionsService,
} = require("../dist/src/inspections/inspections.service");
const { ValidationPipe } = require("@nestjs/common");

const id = "507f1f77bcf86cd799439011";
const config = {
  tenantId: "tenant-a",
  workspaceId: "assembly",
  fields: ["result", "id"],
  filters: { result: "FAIL" },
};
const record = {
  id: "a-1",
  tenantId: "tenant-a",
  workspaceId: "assembly",
  sessionId: "s",
  timestamp: "now",
  result: "FAIL",
  confidence: 0.9,
};

test("DTO validates configuration and rejects operator objects, duplicates and invalid filters", async () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const check = (value) =>
    pipe.transform(value, { type: "body", metatype: CreateExportDto });
  await expect(check(config)).resolves.toBeInstanceOf(CreateExportDto);
  for (const bad of [
    { ...config, tenantId: { $ne: "" } },
    { ...config, workspaceId: " " },
    { ...config, fields: [] },
    { ...config, fields: ["id", "id"] },
    { ...config, fields: ["unknown"] },
    { ...config, filters: { result: "pass" } },
    { ...config, filters: { result: { $ne: "PASS" } } },
    { ...config, filters: null },
    { ...config, outputFilename: "../unsafe.csv" },
  ])
    await expect(check(bad)).rejects.toThrow();
});

test("inspection database query includes tenant, workspace, filter and keyset", async () => {
  const exec = jest.fn().mockResolvedValue([record]);
  const chain = { collation: () => chain, sort: () => chain, limit: () => chain, lean: () => ({ exec }) };
  const find = jest.fn().mockReturnValue(chain);
  const service = new InspectionsService({ find });
  await service.nextBatch("tenant-a", "assembly", "a-9", "a-1", 3, "FAIL");
  expect(find).toHaveBeenCalledWith({ tenantId: "tenant-a", workspaceId: "assembly", result: "FAIL", id: { $gt: "a-1", $lte: "a-9" } });
});

describe("export jobs", () => {
  let dir, state, jobs, inspections, queue, service, processor;
  const { ExportsProcessor } = require("../dist/src/exports/exports.processor");
  const {
    ExportsController,
  } = require("../dist/src/exports/exports.controller");
  const { HTTP_CODE_METADATA } = require("@nestjs/common/constants");
  const query = (value) => ({ lean: () => ({ exec: async () => value }) });
  const matches = (filter) =>
    !filter.status ||
    ((typeof filter.status === "object"
      ? filter.status.$in.includes(state.status)
      : filter.status === state.status) &&
      (!filter.activeRunId || filter.activeRunId === state.activeRunId));
  const apply = (update) => {
    Object.assign(state, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete state[key];
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "looprai-test-"));
    state = {
      _id: id,
      tenantId: "tenant-a",
      workspaceId: "assembly",
      config,
      status: "QUEUED",
      progress: 0,
    };
    jobs = {
      create: jest.fn(async (doc) => {
        Object.assign(state, doc);
        return { id };
      }),
      findById: jest.fn(() => query({ ...state })),
      findOneAndUpdate: jest.fn((filter, update) => {
        if (!matches(filter)) return query(null);
        apply(update);
        return query({ ...state });
      }),
      updateOne: jest.fn(async (filter, update) => {
        if (!matches(filter)) return { matchedCount: 0 };
        apply(update);
        return { matchedCount: 1 };
      }),
    };
    inspections = {
      upperBound: jest.fn().mockResolvedValue(record.id),
      countTo: jest.fn().mockResolvedValue(1),
      nextBatch: jest.fn(async (_t, _w, _u, last) => last ? [] : [record]),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new ExportsService(jobs, queue);
    service.outputDir = dir;
    processor = new ExportsProcessor(jobs, inspections);
    processor.outputDir = dir;
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));
  const queued = (attemptsMade = 0) => ({
    data: { exportJobId: id },
    attemptsMade,
    opts: { attempts: 3 },
  });

  test("creates a queued job, submits its ID, and exposes HTTP 202", async () => {
    await expect(service.create(config)).resolves.toEqual({
      id,
      status: "QUEUED",
    });
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "QUEUED", config }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "export",
      { exportJobId: id },
      { jobId: id },
    );
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        ExportsController.prototype.create,
      ),
    ).toBe(202);
  });
  test("records queue submission failure safely", async () => {
    queue.add.mockRejectedValue(new Error("redis password"));
    await expect(service.create(config)).rejects.toMatchObject({ status: 503 });
    expect(state).toMatchObject({
      status: "FAILED",
      error: "Could not enqueue export",
    });
  });
  test("worker scopes records, updates progress and creates CSV", async () => {
    await processor.process(queued());
    expect(inspections.upperBound).toHaveBeenCalledWith("tenant-a", "assembly", "FAIL");
    expect(state).toMatchObject({
      status: "COMPLETED",
      progress: 100,
      processedRecords: 1,
      totalRecords: 1,
      attemptCount: 1,
    });
    expect(jobs.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ processedRecords: 1 }),
      }),
    );
    expect(await readFile(join(dir, `${id}.csv`), "utf8")).toBe(
      "result,id\r\nFAIL,a-1\r\n",
    );
  });
  test("failure retries successfully without duplicate output and completed jobs are skipped", async () => {
    processor.testHook = jest.fn(async (point) => { if (point === "afterWrite") throw new Error("simulated"); });
    await expect(processor.process(queued())).rejects.toThrow();
    expect(state.status).toBe("QUEUED");
    processor.testHook = async () => {};
    await processor.process(queued(1));
    expect(state).toMatchObject({ status: "COMPLETED", attemptCount: 2 });
    expect(await readFile(join(dir, `${id}.csv`), "utf8")).toBe(
      "result,id\r\nFAIL,a-1\r\n",
    );
    await processor.process(queued(2));
    expect(inspections.upperBound).toHaveBeenCalledTimes(1);
  });
  test("exhausted attempts mark the job failed without exposing the error", async () => {
    inspections.upperBound.mockRejectedValue(new Error("sensitive"));
    await expect(processor.process(queued(2))).rejects.toThrow();
    expect(state).toMatchObject({
      status: "FAILED",
      error: "Export failed",
      attemptCount: 3,
    });
  });
  test("only completed jobs with files can be downloaded", async () => {
    for (const status of ["QUEUED", "PROCESSING", "FAILED"]) {
      state.status = status;
      await expect(service.download(id)).rejects.toMatchObject({ status: 409 });
    }
    await expect(service.download("../secret")).rejects.toMatchObject({
      status: 404,
    });
    state.status = "COMPLETED";
    await expect(service.download(id)).rejects.toMatchObject({ status: 404 });
    state.status = "QUEUED";
    await processor.process(queued());
    const chunks = [];
    for await (const chunk of await service.download(id)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("result,id\r\nFAIL,a-1\r\n");
  });
  test("recovers a published file using its checksum after a crash", async () => {
    await processor.process(queued());
    state.status = "PROCESSING";
    delete state.completedAt;
    inspections.nextBatch.mockClear();
    await processor.process(queued(1));
    expect(state.status).toBe("COMPLETED");
    expect(inspections.nextBatch).not.toHaveBeenCalled();
  });
});
