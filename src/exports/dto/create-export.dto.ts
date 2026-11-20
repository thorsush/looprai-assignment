import { Type } from "class-transformer";
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
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

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  simulateFailure?: boolean;
}
