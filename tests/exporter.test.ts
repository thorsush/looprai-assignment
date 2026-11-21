import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import {
  createCsv,
  csvCell,
  selectRecords,
  validateConfig,
} from "../src/exporter";
import { InspectionRecord } from "../src/types";

const records = JSON.parse(
  readFileSync("data/inspections.json", "utf8"),
) as InspectionRecord[];
const base = {
  tenantId: "tenant-a",
  workspaceId: "assembly",
  fields: ["id", "result"],
  outputFilename: "test.csv",
};

test("isolates tenants and filters workspaces even when workspace names overlap", () => {
  const selected = selectRecords(records, validateConfig(base));
  assert.deepEqual(
    selected.map((r) => r.id),
    ["a-001", "a-002", "a-003", "a-004"],
  );
  const other = selectRecords(
    records,
    validateConfig({ ...base, workspaceId: "packaging" }),
  );
  assert.deepEqual(
    other.map((r) => r.id),
    ["a-005", "a-006"],
  );
});

test("filters PASS and FAIL independently", () => {
  for (const resultFilter of ["PASS", "FAIL"] as const) {
    const selected = selectRecords(
      records,
      validateConfig({ ...base, resultFilter }),
    );
    assert.equal(selected.length, 2);
    assert.ok(selected.every((r) => r.result === resultFilter));
  }
});

test("selects fields in configured order and represents missing values as empty", () => {
  const config = validateConfig({
    ...base,
    fields: ["result", "id", "imageUrl"],
    resultFilter: "FAIL",
  });
  assert.equal(
    createCsv(records, config),
    "result,id,imageUrl\r\nFAIL,a-002,\r\nFAIL,a-003,https://example.com/a-003.jpg\r\n",
  );
});

test("rejects invalid configurations", () => {
  for (const config of [
    null,
    {},
    { ...base, tenantId: " " },
    { ...base, workspaceId: "" },
    { ...base, fields: [] },
    { ...base, fields: ["bad"] },
    { ...base, fields: ["id", "id"] },
    { ...base, resultFilter: "pass" },
    { ...base, outputFilename: "../test.csv" },
    { ...base, outputFilename: "test.txt" },
    { ...base, outputFilename: "a\\b.csv" },
  ]) {
    assert.throws(() => validateConfig(config));
  }
});

test("escapes CSV and neutralizes formula-like strings", () => {
  assert.equal(csvCell('a,"b"\nnext'), '"a,""b""\nnext"');
  assert.equal(csvCell("  =1+1"), "'  =1+1");
  assert.equal(csvCell("\t+cmd"), "'\t+cmd");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell(-2), "-2");
  assert.equal(csvCell(undefined), "");
});

test("CLI writes the expected CSV file", () => {
  const path = "output/customer-a.csv";
  execFileSync(process.execPath, [
    "dist/src/index.js",
    "config/customer-a.json",
  ]);
  const config = validateConfig(
    JSON.parse(readFileSync("config/customer-a.json", "utf8")),
  );
  assert.equal(readFileSync(path, "utf8"), createCsv(records, config));
  unlinkSync(path);
});

test("customer configurations produce distinct fields and row sets", () => {
  const customerA = validateConfig(JSON.parse(readFileSync("config/customer-a.json", "utf8")));
  const customerB = validateConfig(JSON.parse(readFileSync("config/customer-b.json", "utf8")));
  const { createCsv } = require("../src/exporter") as typeof import("../src/exporter");
  const a = createCsv(records, customerA);
  const b = createCsv(records, customerB);
  assert.match(a, /^id,timestamp,result,confidence\r\n/);
  assert.match(b, /^sessionId,id,result,imageUrl\r\n/);
  assert.match(a, /a-002/);
  assert.doesNotMatch(a, /b-001/);
  assert.match(b, /b-001/);
  assert.doesNotMatch(b, /a-001/);
});
