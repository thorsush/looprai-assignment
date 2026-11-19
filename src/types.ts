export const fields = [
  "id",
  "tenantId",
  "workspaceId",
  "sessionId",
  "timestamp",
  "result",
  "confidence",
  "imageUrl",
] as const;

export type Field = (typeof fields)[number];
export type Result = "PASS" | "FAIL";

export interface InspectionRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  timestamp: string;
  result: Result;
  confidence: number;
  imageUrl?: string;
}

export interface ExportConfig {
  tenantId: string;
  workspaceId: string;
  fields: Field[];
  resultFilter?: Result;
  outputFilename: string;
}
