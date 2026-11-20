import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Schema as MongooseSchema } from "mongoose";
import { CreateExportDto } from "./dto/create-export.dto";

@Schema({ collection: "export_jobs", versionKey: false })
export class ExportJob {
  @Prop({ required: true }) tenantId!: string;
  @Prop({ required: true }) workspaceId!: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  config!: CreateExportDto;
  @Prop({
    enum: ["QUEUED", "PROCESSING", "COMPLETED", "FAILED"],
    required: true,
  })
  status!: string;
  @Prop({ default: 0 }) progress!: number;
  @Prop({ default: 0 }) processedRecords!: number;
  @Prop({ default: 0 }) totalRecords!: number;
  @Prop({ default: 0 }) attemptCount!: number;
  @Prop() outputPath?: string;
  @Prop() error?: string;
  @Prop() outputHash?: string;
  @Prop() activeRunId?: string;
  @Prop({ required: true, default: Date.now }) createdAt!: Date;
  @Prop() startedAt?: Date;
  @Prop() completedAt?: Date;
}
export const ExportJobSchema = SchemaFactory.createForClass(ExportJob);
