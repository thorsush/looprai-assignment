import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCsv, validateConfig } from "./exporter";
import { InspectionRecord } from "./types";

try {
  const configPath = process.argv[2];
  if (!configPath)
    throw new Error("Usage: npm run export -- config/customer-a.json");
  const config = validateConfig(
    JSON.parse(readFileSync(resolve(configPath), "utf8")),
  );
  const records = JSON.parse(
    readFileSync(resolve("data/inspections.json"), "utf8"),
  ) as InspectionRecord[];
  const outputDir = resolve("output");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, config.outputFilename);
  writeFileSync(outputPath, createCsv(records, config), "utf8");
  console.log(`Exported CSV to ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
