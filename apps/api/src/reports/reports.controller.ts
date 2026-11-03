import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentProperty, PropertyScoped, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { CurrentPropertyT, IsoDate } from '../frontoffice/common';
import { PosDaysService } from '../pos/days.service';
import { PosReportsService } from '../pos/reports.service';
import { cashShiftsReport, flashReport, hotelReport, Meta, posDayReport, posSalesReport } from './builders';
import { generatedAt, generatedBy, parseFormat, ReportExporter } from './export';
import { FlashReportService } from './flash.service';
import { HotelReportsService } from './hotel-reports.service';

type Q<T extends z.ZodTypeAny> = z.infer<T>;

const MAX_DAYS = 366;
const Range = z
  .object({ from: IsoDate, to: IsoDate, outlet: z.string().regex(/^[A-Z0-9_-]{1,12}$/i).optional(), format: z.string().optional() })
  .refine((r) => r.from <= r.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < MAX_DAYS, { message: `at most ${MAX_DAYS} days at a time`, path: ['to'] });
const OneDay = z.object({ date: IsoDate, format: z.string().optional() });

/**
 * Reports on screen and as downloads (RPT-02, RPT-03, RPT-04, RPT-06, RPT-07,
 * RPT-08). Each JSON route has an /export twin that sends the same figures as
 * CSV (for Excel) or PDF, with the same permission and property scope.
 */
@Controller('properties/:propertyCode/reports')
@PropertyScoped()
export class PropertyReportsController {
  constructor(
    private readonly db: DbService,
    private readonly pos: PosReportsService,
    private readonly days: PosDaysService,
    private readonly hotel: HotelReportsService,
    private readonly flash: FlashReportService,
    private readonly exporter: ReportExporter,
  ) {}

  private async meta(propertyId: string): Promise<Meta> {
    const { rows } = await this.db.tx((q) => q.query<{ name: string }>('SELECT name FROM properties WHERE id = $1', [propertyId]));
    return { scope: rows[0]?.name ?? '', generatedBy: generatedBy(), generatedAt: generatedAt() };
  }

  private async outletName(propertyId: string, code?: string): Promise<string | null> {
    if (!code) return null;
    const { rows } = await this.db.tx((q) =>
      q.query<{ name: string }>('SELECT name FROM outlets WHERE property_id = $1 AND code = $2', [propertyId, code.toUpperCase()]),
    );
    if (!rows[0]) throw new BadRequestException(`No outlet ${code} at this property`);
    return rows[0].name;
  }

  // POS (RPT-03) ------------------------------------------------------------

  @Get('pos-sales/export')
  @RequirePermission('pos.report')
  async posSalesExport(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(Range)) q: Q<typeof Range>, @Res() res: Response) {
    const format = parseFormat(q.format);
    const outlet = await this.outletName(p.id, q.outlet);
    const data = await this.pos.sales(p.id, { from: q.from, to: q.to, outletCode: q.outlet?.toUpperCase() });
    await this.exporter.send(res, posSalesReport(data, await this.meta(p.id), outlet), format, p.code, { from: q.from, to: q.to, outlet: q.outlet ?? null });
  }

  @Get('pos-days/:dayId/export')
  @RequirePermission('pos.report')
  async posDayExport(@CurrentProperty() p: CurrentPropertyT, @Param('dayId', ParseUUIDPipe) id: string, @Query('format') f: string, @Res() res: Response) {
    const format = parseFormat(f);
    const day = await this.days.day(p.id, id);
    await this.exporter.send(res, posDayReport(day, await this.meta(p.id)), format, p.code, { dayId: id });
  }

  // Cash shifts (POS-13, RPT-04 cashier variance) -----------------------------

  @Get('cash-shifts')
  @RequirePermission('pos.report')
  cashShifts(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(Range)) q: Q<typeof Range>) {
    return this.pos.shifts(p.id, { from: q.from, to: q.to, outletCode: q.outlet?.toUpperCase() });
  }

  @Get('cash-shifts/export')
  @RequirePermission('pos.report')
  async cashShiftsExport(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(Range)) q: Q<typeof Range>, @Res() res: Response) {
    const format = parseFormat(q.format);
    const outlet = await this.outletName(p.id, q.outlet);
    const rows = await this.pos.shifts(p.id, { from: q.from, to: q.to, outletCode: q.outlet?.toUpperCase() });
    await this.exporter.send(res, cashShiftsReport(rows, q.from, q.to, await this.meta(p.id), outlet), format, p.code, { from: q.from, to: q.to, outlet: q.outlet ?? null });
  }

  // Hotel (RPT-02) -------------------------------------------------------------

  @Get('hotel')
  @RequirePermission('report.read')
  hotelReport(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(Range)) q: Q<typeof Range>) {
    return this.hotel.report(p.id, q.from, q.to);
  }

  @Get('hotel/export')
  @RequirePermission('report.read')
  async hotelExport(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(Range)) q: Q<typeof Range>, @Res() res: Response) {
    const format = parseFormat(q.format);
    const data = await this.hotel.report(p.id, q.from, q.to);
    await this.exporter.send(res, hotelReport(data, await this.meta(p.id)), format, p.code, { from: q.from, to: q.to });
  }

  // Daily flash, one property (RPT-07) ----------------------------------------

  @Get('flash')
  @RequirePermission('report.read')
  flashReport(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(OneDay)) q: Q<typeof OneDay>) {
    return this.flash.forProperty(p.id, q.date);
  }

  @Get('flash/export')
  @RequirePermission('report.read')
  async flashExport(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(OneDay)) q: Q<typeof OneDay>, @Res() res: Response) {
    const format = parseFormat(q.format);
    const data = await this.flash.forProperty(p.id, q.date);
    await this.exporter.send(res, flashReport([data], null, q.date, await this.meta(p.id)), format, p.code, { date: q.date });
  }
}

/** Group views across every property the user may see (RPT-07 consolidated, RPT-08). */
@Controller('reports')
export class GroupReportsController {
  constructor(
    private readonly flash: FlashReportService,
    private readonly exporter: ReportExporter,
  ) {}

  @Get('flash')
  @RequirePermission('report.read')
  flashReport(@Query(new ZodPipe(OneDay)) q: Q<typeof OneDay>) {
    return this.flash.consolidated(q.date);
  }

  @Get('flash/export')
  @RequirePermission('report.read')
  async flashExport(@Query(new ZodPipe(OneDay)) q: Q<typeof OneDay>, @Res() res: Response) {
    const format = parseFormat(q.format);
    const data = await this.flash.consolidated(q.date);
    const meta: Meta = { scope: data.properties.length > 1 ? 'All properties' : (data.properties[0]?.name ?? ''), generatedBy: generatedBy(), generatedAt: generatedAt() };
    await this.exporter.send(res, flashReport(data.properties, data.properties.length > 1 ? data.group : null, q.date, meta), format, 'GROUP', { date: q.date });
  }
}
