import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Inspection } from './inspection.schema';
import { InspectionRecord } from '../types';

@Injectable()
export class InspectionsService {
  constructor(@InjectModel(Inspection.name) private readonly inspections: Model<Inspection>) {}

  async findForWorkspace(tenantId: string, workspaceId: string): Promise<InspectionRecord[]> {
    return this.inspections.find({ tenantId, workspaceId }).lean().exec() as Promise<InspectionRecord[]>;
  }
}
