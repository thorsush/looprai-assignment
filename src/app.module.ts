import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Inspection, InspectionSchema } from './inspections/inspection.schema';
import { InspectionsService } from './inspections/inspections.service';
import { ExportJob, ExportJobSchema } from './exports/export-job.schema';
import { ExportsController } from './exports/exports.controller';
import { ExportsService } from './exports/exports.service';

@Module({
  imports: [
    MongooseModule.forRoot(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/looprai'),
    MongooseModule.forFeature([{ name: Inspection.name, schema: InspectionSchema }, { name: ExportJob.name, schema: ExportJobSchema }]),
  ],
  controllers: [ExportsController],
  providers: [InspectionsService, ExportsService],
})
export class AppModule {}
