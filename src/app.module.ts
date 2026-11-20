import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { BullModule } from "@nestjs/bullmq";
import { Inspection, InspectionSchema } from "./inspections/inspection.schema";
import { InspectionsService } from "./inspections/inspections.service";
import { ExportJob, ExportJobSchema } from "./exports/export-job.schema";
import { ExportsController } from "./exports/exports.controller";
import { ExportsService } from "./exports/exports.service";
import { ExportsProcessor } from "./exports/exports.processor";

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/looprai",
    ),
    MongooseModule.forFeature([
      { name: Inspection.name, schema: InspectionSchema },
      { name: ExportJob.name, schema: ExportJobSchema },
    ]),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
      },
    }),
    BullModule.registerQueue({
      name: "exports",
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
  ],
  controllers: [ExportsController],
  providers: [InspectionsService, ExportsService, ExportsProcessor],
})
export class AppModule {}
