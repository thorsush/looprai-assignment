import 'dotenv/config';
import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';
import { Inspection, InspectionSchema } from '../src/inspections/inspection.schema';
import { InspectionRecord } from '../src/types';

async function seed() {
  const records = JSON.parse(await readFile('data/inspections.json', 'utf8')) as InspectionRecord[];
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/looprai');
  const model = mongoose.model(Inspection.name, InspectionSchema);
  await model.init();
  await model.bulkWrite(records.map((record) => ({ updateOne: { filter: { id: record.id }, update: { $set: record }, upsert: true } })));
  console.log(`Seeded ${records.length} inspections`);
}
seed().catch(() => { console.error('Seed failed'); process.exitCode = 1; }).finally(() => mongoose.disconnect());
