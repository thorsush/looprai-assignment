import { Body, Controller, Get, Header, Param, Post, StreamableFile } from '@nestjs/common';
import { CreateExportDto } from './dto/create-export.dto';
import { ExportsService } from './exports.service';

@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}
  @Post() create(@Body() config: CreateExportDto) { return this.exportsService.create(config); }
  @Get(':id') findOne(@Param('id') id: string) { return this.exportsService.findOne(id); }
  @Get(':id/download') @Header('Content-Type', 'text/csv; charset=utf-8')
  async download(@Param('id') id: string) {
    const csv = await this.exportsService.download(id);
    return new StreamableFile(csv, { disposition: `attachment; filename="${id}.csv"` });
  }
}
