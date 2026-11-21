import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import { ResolvedExportConfig } from './dto/create-export.dto';

@Schema({ collection: 'export_config_versions', versionKey: false })
export class ExportConfigVersion {
  @Prop({ required: true, immutable: true }) tenantId!: string;
  @Prop({ required: true, immutable: true }) configId!: string;
  @Prop({ required: true, immutable: true }) version!: number;
  @Prop({ required: true, immutable: true }) outputSchemaVersion!: number;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true, immutable: true }) config!: ResolvedExportConfig;
  @Prop({ required: true, immutable: true }) fingerprint!: string;
  @Prop({ required: true, default: Date.now, immutable: true }) createdAt!: Date;
}

export const ExportConfigVersionSchema = SchemaFactory.createForClass(ExportConfigVersion);
ExportConfigVersionSchema.index({ tenantId: 1, configId: 1, version: 1 }, { unique: true });
