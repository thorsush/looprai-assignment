require('reflect-metadata');
const { validate } = require('class-validator');
const { plainToInstance } = require('class-transformer');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CreateExportDto } = require('../dist/src/exports/dto/create-export.dto');
const { ExportsService } = require('../dist/src/exports/exports.service');
const { InspectionsService } = require('../dist/src/inspections/inspections.service');
const { ValidationPipe } = require('@nestjs/common');

const id = '507f1f77bcf86cd799439011';
const config = { tenantId: 'tenant-a', workspaceId: 'assembly', fields: ['result', 'id'], filters: { result: 'FAIL' } };
const record = { id: 'a-1', tenantId: 'tenant-a', workspaceId: 'assembly', sessionId: 's', timestamp: 'now', result: 'FAIL', confidence: 0.9 };

test('DTO validates configuration and rejects operator objects, duplicates and invalid filters', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const check = (value) => pipe.transform(value, { type: 'body', metatype: CreateExportDto });
  await expect(check(config)).resolves.toBeInstanceOf(CreateExportDto);
  for (const bad of [
    { ...config, tenantId: { $ne: '' } }, { ...config, workspaceId: ' ' },
    { ...config, fields: [] }, { ...config, fields: ['id', 'id'] },
    { ...config, fields: ['unknown'] }, { ...config, filters: { result: 'pass' } },
    { ...config, filters: { result: { $ne: 'PASS' } } }, { ...config, filters: null },
    { ...config, outputFilename: '../unsafe.csv' },
  ]) await expect(check(bad)).rejects.toThrow();
});

test('inspection database query includes tenant and workspace', async () => {
  const exec = jest.fn().mockResolvedValue([record]);
  const find = jest.fn().mockReturnValue({ lean: () => ({ exec }) });
  const service = new InspectionsService({ find });
  await service.findForWorkspace('tenant-a', 'assembly');
  expect(find).toHaveBeenCalledWith({ tenantId: 'tenant-a', workspaceId: 'assembly' });
});

describe('export jobs', () => {
  let dir, job, jobs, inspections, service;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'looprai-test-'));
    job = { id, status: 'PENDING', save: jest.fn().mockResolvedValue(undefined) };
    jobs = { create: jest.fn().mockResolvedValue(job), findById: jest.fn() };
    inspections = { findForWorkspace: jest.fn().mockResolvedValue([record]) };
    service = new ExportsService(jobs, inspections);
    service.outputDir = dir;
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  test('creates and completes a job with selected CSV', async () => {
    await expect(service.create(config)).resolves.toEqual({ id, status: 'COMPLETED' });
    expect(jobs.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING', tenantId: 'tenant-a', config }));
    expect(job.save).toHaveBeenCalledTimes(2);
    expect(inspections.findForWorkspace).toHaveBeenCalledWith('tenant-a', 'assembly');
    expect(await readFile(join(dir, `${id}.csv`), 'utf8')).toBe('result,id\r\nFAIL,a-1\r\n');
    expect(job.outputPath).toBe(`output/${id}.csv`);
    expect(job.completedAt).toBeInstanceOf(Date);
  });
  test('records a safe failure when generation fails', async () => {
    inspections.findForWorkspace.mockRejectedValue(new Error('secret database details'));
    await expect(service.create(config)).resolves.toEqual({ id, status: 'FAILED' });
    expect(job.error).toBe('Export failed');
    expect(job.outputPath).toBeUndefined();
  });
  test('only completed jobs with files can be downloaded', async () => {
    const find = (status) => jobs.findById.mockReturnValue({ lean: () => ({ exec: async () => status ? { _id: id, status } : null }) });
    for (const status of ['PENDING', 'PROCESSING', 'FAILED']) {
      find(status);
      await expect(service.download(id)).rejects.toMatchObject({ status: 409 });
    }
    find(null);
    await expect(service.download(id)).rejects.toMatchObject({ status: 404 });
    await expect(service.download('../secret')).rejects.toMatchObject({ status: 404 });
    find('COMPLETED');
    await expect(service.download(id)).rejects.toMatchObject({ status: 404 });
    await service.create(config);
    expect((await service.download(id)).toString()).toBe('result,id\r\nFAIL,a-1\r\n');
  });
});
