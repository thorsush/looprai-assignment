import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import { CreateExportDto } from './dto/create-export.dto';

@Schema({ collection: 'export_jobs', versionKey: false })
export class ExportJob {
  @Prop({ required: true }) tenantId!: string;
  @Prop({ required: true }) workspaceId!: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) config!: CreateExportDto;
  @Prop({ enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'], required: true }) status!: string;
  @Prop() outputPath?: string;
  @Prop() error?: string;
  @Prop({ required: true, default: Date.now }) createdAt!: Date;
  @Prop() completedAt?: Date;
}
export const ExportJobSchema = SchemaFactory.createForClass(ExportJob);
