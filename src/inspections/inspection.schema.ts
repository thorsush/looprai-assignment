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
