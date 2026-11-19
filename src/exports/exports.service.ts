import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCsv } from '../exporter';
import { InspectionsService } from '../inspections/inspections.service';
import { CreateExportDto } from './dto/create-export.dto';
import { ExportJob } from './export-job.schema';

@Injectable()
export class ExportsService {
  private readonly outputDir = resolve('output');
  constructor(
    @InjectModel(ExportJob.name) private readonly jobs: Model<ExportJob>,
    private readonly inspections: InspectionsService,
  ) {}

  async create(config: CreateExportDto) {
    const job = await this.jobs.create({ tenantId: config.tenantId, workspaceId: config.workspaceId, config, status: 'PENDING' });
    try {
      job.status = 'PROCESSING';
      await job.save();
      const records = await this.inspections.findForWorkspace(config.tenantId, config.workspaceId);
      const filename = `${job.id}.csv`;
      const csv = createCsv(records, { tenantId: config.tenantId, workspaceId: config.workspaceId, fields: config.fields, resultFilter: config.filters?.result, outputFilename: filename });
      await mkdir(this.outputDir, { recursive: true });
      await writeFile(join(this.outputDir, filename), csv, 'utf8');
      job.outputPath = `output/${filename}`;
      job.status = 'COMPLETED';
      job.completedAt = new Date();
      await job.save();
    } catch {
      job.status = 'FAILED';
      job.outputPath = undefined;
      job.error = 'Export failed';
      job.completedAt = new Date();
      try { await job.save(); } catch { throw new InternalServerErrorException('Could not update export job'); }
    }
    return { id: job.id, status: job.status };
  }

  async findOne(id: string) {
    if (!/^[a-f\d]{24}$/i.test(id) || !isValidObjectId(id)) throw new NotFoundException('Export job not found');
    const job = await this.jobs.findById(id).lean().exec();
    if (!job) throw new NotFoundException('Export job not found');
    const { _id, ...details } = job;
    return { id: String(_id), ...details };
  }

  async download(id: string): Promise<Buffer> {
    const job = await this.findOne(id);
    if (job.status !== 'COMPLETED') throw new ConflictException('Export is not available');
    try {
      // Derive the path from the validated ID, never from a stored or supplied path.
      return await readFile(join(this.outputDir, `${id}.csv`));
    } catch {
      throw new NotFoundException('Export file not found');
    }
  }
}
