import { Type } from "class-transformer";
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
  Max,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { fields, Field, Result } from "../../types";

class ExportFiltersDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["PASS", "FAIL"])
  result?: Result;
}

export class CreateExportDto {
  @ValidateIf((_object, value) => value !== undefined) @IsString() @Matches(/^[a-zA-Z0-9_-]+$/)
  configId?: string;

  // Configuration revision; omitted legacy requests resolve to version 1.
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt() @IsPositive() @Max(Number.MAX_SAFE_INTEGER)
  version?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["csv"])
  type?: "csv";

  // Output contract version is separate from the customer's configuration revision.
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn([1])
  outputSchemaVersion?: number;
  @IsString() @IsNotEmpty() @Matches(/\S/) tenantId!: string;
  @IsString() @IsNotEmpty() @Matches(/\S/) workspaceId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(fields, { each: true })
  fields!: Field[];
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ExportFiltersDto)
  filters?: ExportFiltersDto;
}


export type ResolvedExportConfig = CreateExportDto & {
  configId: string;
  version: number;
  type: "csv";
  outputSchemaVersion: 1;
};

export function resolveExportConfig(config: CreateExportDto): ResolvedExportConfig {
  return {
    configId: config.configId ?? "inspection-report",
    version: config.version ?? 1,
    type: config.type ?? "csv",
    outputSchemaVersion: (config.outputSchemaVersion ?? 1) as 1,
    tenantId: config.tenantId,
    workspaceId: config.workspaceId,
    fields: [...config.fields],
    ...(config.filters ? { filters: { ...config.filters } } : {}),
  };
}
