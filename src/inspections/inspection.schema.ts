import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

@Schema({ collection: "inspections", versionKey: false })
export class Inspection {
  @Prop({ required: true, unique: true }) id!: string;
  @Prop({ required: true, index: true }) tenantId!: string;
  @Prop({ required: true, index: true }) workspaceId!: string;
  @Prop({ required: true }) sessionId!: string;
  @Prop({ required: true }) timestamp!: string;
  @Prop({ required: true, enum: ["PASS", "FAIL"] }) result!: string;
  @Prop({ required: true }) confidence!: number;
  @Prop() imageUrl?: string;
}
export const InspectionSchema = SchemaFactory.createForClass(Inspection);
// Both indexes use simple collation; the second supports filtered exports.
InspectionSchema.index(
  { tenantId: 1, workspaceId: 1, id: 1 },
  { collation: { locale: "simple" } },
);
InspectionSchema.index(
  { tenantId: 1, workspaceId: 1, result: 1, id: 1 },
  { collation: { locale: "simple" } },
);
