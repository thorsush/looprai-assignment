import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Inspection } from "./inspection.schema";
import { InspectionRecord, Result } from "../types";

@Injectable()
export class InspectionsService {
  constructor(
    @InjectModel(Inspection.name)
    private readonly inspections: Model<Inspection>,
  ) {}

  // Simple binary collation gives IDs a stable bytewise lexicographic order.
  async upperBound(
    tenantId: string,
    workspaceId: string,
    result?: Result,
  ): Promise<string | null> {
    const doc = await this.inspections
      .findOne({ tenantId, workspaceId, ...(result ? { result } : {}) })
      .collation({ locale: "simple" })
      .sort({ id: -1 })
      .select({ id: 1, _id: 0 })
      .lean()
      .exec();
    return doc?.id ?? null;
  }

  async countTo(
    tenantId: string,
    workspaceId: string,
    upperBoundId: string,
    result?: Result,
  ): Promise<number> {
    return this.inspections
      .countDocuments({
        tenantId,
        workspaceId,
        ...(result ? { result } : {}),
        id: { $lte: upperBoundId },
      })
      .collation({ locale: "simple" })
      .exec();
  }

  async nextBatch(
    tenantId: string,
    workspaceId: string,
    upperBoundId: string,
    lastProcessedId: string | null,
    limit: number,
    result?: Result,
  ): Promise<InspectionRecord[]> {
    return this.inspections
      .find({
        tenantId,
        workspaceId,
        ...(result ? { result } : {}),
        id: {
          ...(lastProcessedId !== null ? { $gt: lastProcessedId } : {}),
          $lte: upperBoundId,
        },
      })
      .collation({ locale: "simple" })
      .sort({ id: 1 })
      .limit(limit)
      .lean()
      .exec() as Promise<InspectionRecord[]>;
  }
}
