require("reflect-metadata");
const {
  mkdtemp,
  rm,
  readFile,
  stat,
  truncate,
  unlink,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ExportsProcessor } = require("../dist/src/exports/exports.processor");

const id = "507f1f77bcf86cd799439011";
const makeRecord = (n, overrides = {}) => ({
  id: `item-${String(n).padStart(5, "0")}`,
  tenantId: "a",
  workspaceId: "w",
  sessionId: "s",
  timestamp: "t",
  result: n % 2 ? "FAIL" : "PASS",
  confidence: 1,
  ...overrides,
});
const query = (value) => ({ lean: () => ({ exec: async () => value }) });
let dir, state, jobs, inspections, processor, records;
const job = (attemptsMade = 0) => ({
  data: { exportJobId: id },
  attemptsMade,
  opts: { attempts: 3 },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "checkpoint-"));
  process.env.EXPORT_BATCH_SIZE = "3";
  records = Array.from({ length: 10 }, (_, i) => makeRecord(i + 1));
  state = {
    _id: id,
    tenantId: "a",
    workspaceId: "w",
    status: "QUEUED",
    config: { tenantId: "a", workspaceId: "w", fields: ["id", "result"] },
    checkpointVersion: 0,
    processedRecords: 0,
    outputOffsetBytes: 0,
    lastProcessedId: null,
    upperBoundId: null,
  };
  const match = (filter) =>
    (!filter.status ||
      (typeof filter.status === "object"
        ? filter.status.$in.includes(state.status)
        : filter.status === state.status)) &&
    (!filter.activeRunId || state.activeRunId === filter.activeRunId);
  const update = (doc) => {
    Object.assign(state, doc.$set || {});
    state.checkpointVersion += doc.$inc?.checkpointVersion || 0;
    for (const key of Object.keys(doc.$unset || {})) delete state[key];
  };
  jobs = {
    findById: () => query({ ...state }),
    findOneAndUpdate: (filter, doc) => {
      if (!match(filter)) return query(null);
      update(doc);
      return query({ ...state });
    },
    updateOne: jest.fn(async (filter, doc) => {
      if (!match(filter)) return { matchedCount: 0 };
      update(doc);
      return { matchedCount: 1 };
    }),
  };
  const selected = (t, w, r) =>
    records
      .filter(
        (x) =>
          x.tenantId === t && x.workspaceId === w && (!r || x.result === r),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  inspections = {
    upperBound: jest.fn(
      async (t, w, r) => selected(t, w, r).at(-1)?.id ?? null,
    ),
    countTo: jest.fn(
      async (t, w, u, r) => selected(t, w, r).filter((x) => x.id <= u).length,
    ),
    nextBatch: jest.fn(async (t, w, u, last, limit, r) =>
      selected(t, w, r)
        .filter((x) => x.id <= u && (!last || x.id > last))
        .slice(0, limit),
    ),
  };
  processor = new ExportsProcessor(jobs, inspections);
  processor.outputDir = dir;
});
afterEach(async () => {
  delete process.env.EXPORT_BATCH_SIZE;
  await rm(dir, { recursive: true, force: true });
});

test("ordered batches preserve filter, fields, isolation and the captured upper boundary", async () => {
  state.config.fields = ["result", "id"];
  state.config.filters = { result: "FAIL" };
  records.push(
    makeRecord(99, { tenantId: "other" }),
    makeRecord(98, { workspaceId: "other" }),
  );
  let added = false;
  processor.testHook = async (point) => {
    if (!added && point === "afterCheckpoint") {
      records.push(makeRecord(99));
      added = true;
    }
  };
  await processor.process(job());
  const csv = await readFile(join(dir, `${id}.csv`), "utf8");
  expect(csv).toBe(
    "result,id\r\n" +
      [1, 3, 5, 7, 9]
        .map((n) => `FAIL,item-${String(n).padStart(5, "0")}\r\n`)
        .join(""),
  );
  expect(state).toMatchObject({
    upperBoundId: "item-00009",
    processedRecords: 5,
    totalRecords: 5,
    progress: 100,
  });
  expect(
    inspections.nextBatch.mock.calls.every(
      (call) => call[4] === 3 && call[0] === "a" && call[1] === "w",
    ),
  ).toBe(true);
});

test.each(["beforeBatch", "afterWrite", "afterCheckpoint", "afterRename"])(
  "recovers interruption at %s without duplicated rows",
  async (failurePoint) => {
    processor.testHook = async (point) => {
      if (point === failurePoint) throw Error("test crash");
    };
    await expect(processor.process(job())).rejects.toThrow("test crash");
    if (failurePoint === "afterWrite")
      expect((await stat(join(dir, `${id}.part`))).size).toBeGreaterThan(
        state.outputOffsetBytes,
      );
    processor.testHook = async () => {};
    await processor.process(job(1));
    const csv = await readFile(join(dir, `${id}.csv`), "utf8");
    expect(csv).toBe(
      "id,result\r\n" + records.map((x) => `${x.id},${x.result}\r\n`).join(""),
    );
    expect(state).toMatchObject({
      status: "COMPLETED",
      processedRecords: 10,
      lastProcessedId: "item-00010",
    });
  },
);

test.each(["missing", "short"])(
  "refuses a %s checkpoint file",
  async (mode) => {
    processor.testHook = async (point) => {
      if (point === "afterCheckpoint") throw Error("stop");
    };
    await expect(processor.process(job())).rejects.toThrow();
    const part = join(dir, `${id}.part`);
    if (mode === "missing") await unlink(part);
    else await truncate(part, state.outputOffsetBytes - 1);
    processor.testHook = async () => {};
    await expect(processor.process(job(1))).rejects.toThrow();
    expect(state).toMatchObject({
      status: "FAILED",
      error: expect.stringContaining("cannot be recovered"),
    });
  },
);

test("larger synthetic export reads only bounded batches and writes one header", async () => {
  records = Array.from({ length: 2500 }, (_, i) => makeRecord(i + 1));
  process.env.EXPORT_BATCH_SIZE = "64";
  await processor.process(job());
  const csv = await readFile(join(dir, `${id}.csv`), "utf8");
  expect(csv.trimEnd().split("\r\n")).toHaveLength(2501);
  expect(csv.match(/id,result/g)).toHaveLength(1);
  expect(inspections.nextBatch.mock.calls.length).toBeGreaterThan(39);
  expect(inspections.nextBatch.mock.calls.every((call) => call[4] === 64)).toBe(
    true,
  );
});
