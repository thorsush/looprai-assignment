import { ExportConfig, Field, fields, InspectionRecord } from "./types";

export function validateConfig(value: unknown): ExportConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Configuration must be an object");
  }
  const config = value as Record<string, unknown>;
  for (const key of ["tenantId", "workspaceId"] as const) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`${key} is required`);
    }
  }
  if (!Array.isArray(config.fields) || config.fields.length === 0) {
    throw new Error("fields must be a nonempty array");
  }
  if (
    !config.fields.every(
      (field) => typeof field === "string" && fields.includes(field as Field),
    )
  ) {
    throw new Error("fields contains an unknown field");
  }
  if (new Set(config.fields).size !== config.fields.length) {
    throw new Error("fields must not contain duplicates");
  }
  if (
    config.resultFilter !== undefined &&
    config.resultFilter !== "PASS" &&
    config.resultFilter !== "FAIL"
  ) {
    throw new Error("resultFilter must be PASS or FAIL");
  }
  // Restrict filenames to a single portable basename inside output/.
  if (
    typeof config.outputFilename !== "string" ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.csv$/i.test(config.outputFilename) ||
    config.outputFilename.includes("..")
  ) {
    throw new Error("outputFilename must be a safe .csv filename");
  }
  return config as unknown as ExportConfig;
}

export function selectRecords(
  records: InspectionRecord[],
  config: ExportConfig,
): InspectionRecord[] {
  return records.filter(
    (record) =>
      record.tenantId === config.tenantId &&
      record.workspaceId === config.workspaceId &&
      (config.resultFilter === undefined ||
        record.result === config.resultFilter),
  );
}

export function csvCell(value: string | number | undefined): string {
  let text = value === undefined ? "" : String(value);
  // Spreadsheet programs may ignore leading whitespace before a formula marker.
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createCsv(
  records: InspectionRecord[],
  config: ExportConfig,
): string {
  const rows = [
    config.fields.map(csvCell).join(","),
    ...selectRecords(records, config).map((record) =>
      config.fields.map((field) => csvCell(record[field])).join(","),
    ),
  ];
  return `${rows.join("\r\n")}\r\n`;
}
