import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { HOUSE_ACCOUNT_KINDS, POS_TENDERS, SERVICE_TYPES } from '@hotel/shared';
import { z } from 'zod';
import { CurrentProperty, PropertyScoped, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { Amount, ApprovalInput, CurrentPropertyT, IsoDate, Quantity, Reason, Time } from '../frontoffice/common';
import { FoliosService } from '../frontoffice/folios.service';
import { Idempotent } from '../idempotency/idempotency';
import { PosChecksService } from './checks.service';
import { PosDaysService } from './days.service';
import { PosMenuService } from './menu.service';
import { renderCheck, renderDayReport, renderTicket } from './render';
import { PosReportsService } from './reports.service';
import { PosSettingsService } from './settings.service';
import { PosSettlementService } from './settlement.service';
import { PosShiftsService } from './shifts.service';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
type Body<S extends z.ZodTypeAny> = z.infer<S>;
const Code = z.string().regex(/^[A-Za-z0-9-]{2,24}$/);
const Uuid = z.string().uuid();
const Percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) <= 100, 'at most 100');

const OpenCheck = z.object({
  id: Uuid.optional(), // generated on the device for offline capture (OPS-05)
  serviceType: z.enum(SERVICE_TYPES),
  tableId: Uuid.nullish(),
  tabName: z.string().trim().max(60).nullish(),
  covers: z.number().int().min(0).max(200).optional(),
  stayId: Uuid.nullish(),
  notes: z.string().max(500).nullish(),
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{4,80}$/).nullish(),
  clientOpenedAt: z.string().datetime({ offset: true }).nullish(),
});
const AddLines = z.object({
  lines: z
    .array(
      z.object({
        id: Uuid.optional(),
        portionId: Uuid,
        quantity: Quantity.refine((v) => Number(v) > 0, 'must be more than 0'),
        modifierOptionIds: z.array(Uuid).max(20).optional(),
        notes: z.string().trim().max(200).nullish(),
      }),
    )
    .min(1)
    .max(100),
  acknowledgeWarnings: z.boolean().optional(),
  liquorOverrideReason: Reason.optional(),
  approval: ApprovalInput,
});
const Discount = z.object({ lineIds: z.array(Uuid).max(100).optional(), percent: Percent, reason: Reason, approval: ApprovalInput });
const CancelLines = z.object({ lineIds: z.array(Uuid).min(1).max(100), reason: Reason, approval: ApprovalInput });
const Transfer = z
  .object({ tableId: Uuid.nullish(), waiterId: Uuid.optional(), tabName: z.string().trim().max(60).nullish(), covers: z.number().int().min(0).max(200).optional() })
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
const Merge = z.object({ fromCheckIds: z.array(Uuid).min(1).max(20) });
const Split = z.object({ parts: z.array(z.object({ lineId: Uuid, quantity: Quantity.optional() })).min(1).max(100) });
const Serve = z.object({ lineIds: z.array(Uuid).max(100).optional() });
const VoidCheck = z.object({ reason: Reason, approval: ApprovalInput });
const Pay = z.object({
  tenders: z
    .array(
      z.object({
        tender: z.enum(POS_TENDERS),
        amount: Amount,
        tendered: Amount.nullish(),
        reference: z.string().trim().min(3).max(60).nullish(),
        status: z.enum(['pending', 'confirmed']).optional(),
      }),
    )
    .min(1)
    .max(10),
});
const ResolvePayment = z.object({ outcome: z.enum(['confirmed', 'failed']), reason: Reason.optional() });
const RoomCharge = z.object({
  stayId: Uuid,
  acknowledgement: z.object({
    method: z.enum(['guest_signature', 'staff_verified']),
    signedName: z.string().trim().min(2).max(120),
    signature: z.string().max(200_000).regex(/^data:image\/(png|svg\+xml);base64,/).nullish(),
  }),
});
const HouseAccountCharge = z.object({ houseAccountCode: Code, reason: Reason, approval: ApprovalInput });
const Refund = z.object({ paymentId: Uuid, amount: Amount, reason: Reason, reference: z.string().trim().max(60).nullish(), approval: ApprovalInput });
const Reprint = z.object({ reason: Reason });
const TicketStatus = z.object({ status: z.enum(['preparing', 'ready', 'done']) });
const CloseDay = z.object({ businessDate: IsoDate });
const OpenShift = z.object({ outletCode: Code, openingFloat: Amount, handoverFromId: Uuid.nullish() });
const Movement = z.object({ kind: z.enum(['paid_in', 'paid_out', 'drop']), amount: Amount, reason: Reason, approval: ApprovalInput });
const CloseShift = z.object({ countedAmount: Amount, note: z.string().max(500).nullish() });
const ReviewShift = z.object({ note: Reason, approval: ApprovalInput });
const UpdatePrice = z.object({
  price: Amount.optional(),
  isFavourite: z.boolean().optional(),
  stockRemaining: Quantity.nullish(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
const Availability = z.object({ isAvailable: z.boolean() });
const AddToOutlet = z.object({ itemCode: Code, portionCode: z.string().regex(/^[A-Za-z0-9]{2,8}$/).optional(), price: Amount });
const CreateItem = z.object({
  code: Code,
  name: z.string().trim().min(2).max(120),
  description: z.string().max(500).nullish(),
  categoryCode: Code,
  chargeCode: z.string().min(2).max(16),
  isAlcohol: z.boolean(),
  sapItemCode: z.string().max(50).nullish(),
  portions: z.array(z.object({ code: z.string().regex(/^[A-Za-z0-9]{2,8}$/), name: z.string().max(40) })).min(1).max(10),
  modifierGroupCodes: z.array(Code).max(10).optional(),
});
const CopyOutlet = z.object({ fromOutletCode: Code, toOutletCode: Code });
const HouseAccount = z.object({
  code: Code,
  name: z.string().trim().min(2).max(120),
  kind: z.enum(HOUSE_ACCOUNT_KINDS),
  monthlyLimit: Amount.nullish(),
  costCentre: z.string().max(40).nullish(),
});
const PropertySettings = z
  .object({ businessDayCutoff: Time.optional(), posDiscountFreePercent: Percent.optional() })
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
const OutletSettings = z.object({
  posEnabled: z.boolean().optional(),
  businessDayCutoff: Time.nullish(),
  serviceTypes: z.array(z.enum(SERVICE_TYPES)).min(1).optional(),
  liquorPolicy: z.enum(['block', 'warn']).optional(),
  stockPolicy: z.enum(['block', 'warn']).optional(),
  liquorHours: z.array(z.object({ weekday: z.number().int().min(1).max(7), opensAt: Time, closesAt: Time })).max(7).optional(),
  routes: z.object({ kitchen: Code.nullish(), bar: Code.nullish() }).optional(),
});
const SalesQuery = z.object({ from: IsoDate, to: IsoDate, outlet: Code.optional() });

// ---------------------------------------------------------------------------
// Floor: outlets, menus, checks and orders (POS-01 … POS-08, POS-11, POS-12, POS-17)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode/pos')
@PropertyScoped()
export class PosController {
  constructor(
    private readonly days: PosDaysService,
    private readonly menu: PosMenuService,
    private readonly checks: PosChecksService,
    private readonly settlement: PosSettlementService,
    private readonly folios: FoliosService,
  ) {}

  @Get('outlets')
  @RequirePermission('pos.use')
  outlets(@CurrentProperty() p: CurrentPropertyT) {
    return this.days.outlets(p.id);
  }

  @Get('outlets/:outletCode/menu')
  @RequirePermission('pos.use')
  outletMenu(@CurrentProperty() p: CurrentPropertyT, @Param('outletCode') outletCode: string) {
    return this.menu.outletMenu(p.id, outletCode);
  }

  @Get('outlets/:outletCode/checks')
  @RequirePermission('pos.use')
  list(@CurrentProperty() p: CurrentPropertyT, @Param('outletCode') outletCode: string, @Query('status') status?: string) {
    const s = ['open', 'closed', 'void', 'merged', 'all'].includes(status ?? '') ? status! : 'open';
    return this.checks.list(p.id, outletCode, s);
  }

  @Post('outlets/:outletCode/checks')
  @RequirePermission('pos.use')
  @Idempotent()
  open(@CurrentProperty() p: CurrentPropertyT, @Param('outletCode') outletCode: string, @Body(new ZodPipe(OpenCheck)) b: Body<typeof OpenCheck>) {
    return this.checks.open(p.id, outletCode, b);
  }

  @Get('checks/:checkId')
  @RequirePermission('pos.use')
  get(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string) {
    return this.checks.get(p.id, id);
  }

  @Get('checks/:checkId/events')
  @RequirePermission('pos.use')
  events(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string) {
    return this.checks.events(p.id, id);
  }

  @Get('checks/:checkId/print')
  @RequirePermission('pos.use')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async print(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string) {
    return renderCheck(await this.checks.get(p.id, id), await this.folios.headerFor(p.id));
  }

  @Post('checks/:checkId/lines')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  addLines(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(AddLines)) b: Body<typeof AddLines>) {
    return this.checks.addLines(p.id, id, b);
  }

  @Post('checks/:checkId/send')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  send(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string) {
    return this.checks.send(p.id, id);
  }

  @Post('checks/:checkId/serve')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  serve(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Serve)) b: Body<typeof Serve>) {
    return this.checks.serve(p.id, id, b.lineIds);
  }

  @Post('checks/:checkId/discount')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  discount(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Discount)) b: Body<typeof Discount>) {
    return this.checks.discount(p.id, id, b);
  }

  @Post('checks/:checkId/cancel-lines')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  cancelLines(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CancelLines)) b: Body<typeof CancelLines>) {
    return this.checks.cancelLines(p.id, id, b);
  }

  @Post('checks/:checkId/transfer')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  transfer(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Transfer)) b: Body<typeof Transfer>) {
    return this.checks.transfer(p.id, id, b);
  }

  @Post('checks/:checkId/merge')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  merge(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Merge)) b: Body<typeof Merge>) {
    return this.checks.merge(p.id, id, b.fromCheckIds);
  }

  @Post('checks/:checkId/split')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  split(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Split)) b: Body<typeof Split>) {
    return this.checks.split(p.id, id, b.parts);
  }

  @Post('checks/:checkId/void')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  void(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoidCheck)) b: Body<typeof VoidCheck>) {
    return this.checks.void(p.id, id, b);
  }

  // Settlement (POS-08 … POS-11, POS-18)

  @Post('checks/:checkId/payments')
  @HttpCode(200)
  @RequirePermission('pos.settle')
  @Idempotent()
  pay(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Pay)) b: Body<typeof Pay>) {
    return this.settlement.pay(p.id, id, b.tenders);
  }

  @Post('payments/:paymentId/resolve')
  @HttpCode(200)
  @RequirePermission('pos.settle')
  @Idempotent()
  resolve(@CurrentProperty() p: CurrentPropertyT, @Param('paymentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ResolvePayment)) b: Body<typeof ResolvePayment>) {
    return this.settlement.resolvePayment(p.id, id, b.outcome, b.reason);
  }

  @Post('checks/:checkId/close')
  @HttpCode(200)
  @RequirePermission('pos.settle')
  @Idempotent()
  closeZero(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string) {
    return this.settlement.closeZero(p.id, id);
  }

  @Get('in-house')
  @RequirePermission('pos.room_charge')
  inHouse(@CurrentProperty() p: CurrentPropertyT, @Query('q') q = '') {
    return this.settlement.lookupStays(p.id, q.slice(0, 60));
  }

  @Post('checks/:checkId/room-charge')
  @HttpCode(200)
  @RequirePermission('pos.room_charge')
  @Idempotent()
  roomCharge(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RoomCharge)) b: Body<typeof RoomCharge>) {
    return this.settlement.roomCharge(p.id, id, b);
  }

  @Post('checks/:checkId/house-account')
  @HttpCode(200)
  @RequirePermission('pos.settle')
  @Idempotent()
  houseAccount(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(HouseAccountCharge)) b: Body<typeof HouseAccountCharge>) {
    return this.settlement.houseAccount(p.id, id, b);
  }

  @Post('checks/:checkId/refunds')
  @HttpCode(200)
  @RequirePermission('pos.refund')
  @Idempotent()
  refund(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Refund)) b: Body<typeof Refund>) {
    return this.settlement.refund(p.id, id, b);
  }
}

// ---------------------------------------------------------------------------
// Kitchen and bar stations (POS-07)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode/pos')
@PropertyScoped()
export class PosStationsController {
  constructor(
    private readonly checks: PosChecksService,
    private readonly menu: PosMenuService,
  ) {}

  @Get('stations')
  @RequirePermission('pos.kitchen')
  stations(@CurrentProperty() p: CurrentPropertyT) {
    return this.menu.stations(p.id);
  }

  @Get('stations/:stationCode/tickets')
  @RequirePermission('pos.kitchen')
  tickets(@CurrentProperty() p: CurrentPropertyT, @Param('stationCode') code: string, @Query('done') done?: string) {
    return this.checks.stationTickets(p.id, code, done === 'true');
  }

  @Post('tickets/:ticketId/status')
  @HttpCode(200)
  @RequirePermission('pos.kitchen')
  @Idempotent()
  status(@CurrentProperty() p: CurrentPropertyT, @Param('ticketId', ParseUUIDPipe) id: string, @Body(new ZodPipe(TicketStatus)) b: Body<typeof TicketStatus>) {
    return this.checks.ticketStatus(p.id, id, b.status);
  }

  @Get('tickets/:ticketId/print')
  @RequirePermission('pos.kitchen')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async print(@CurrentProperty() p: CurrentPropertyT, @Param('ticketId', ParseUUIDPipe) id: string) {
    return renderTicket(await this.checks.ticketFor(p.id, id));
  }

  @Post('tickets/:ticketId/reprint')
  @HttpCode(200)
  @RequirePermission('pos.kitchen')
  @Idempotent()
  reprint(@CurrentProperty() p: CurrentPropertyT, @Param('ticketId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Reprint)) b: Body<typeof Reprint>) {
    return this.checks.reprint(p.id, id, b.reason);
  }
}

// ---------------------------------------------------------------------------
// Cashier shifts (POS-13) and trading days (POS day close)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode/pos')
@PropertyScoped()
export class PosCashController {
  constructor(
    private readonly shifts: PosShiftsService,
    private readonly days: PosDaysService,
    private readonly reports: PosReportsService,
    private readonly folios: FoliosService,
  ) {}

  @Get('shifts/current')
  @RequirePermission('pos.shift')
  current(@CurrentProperty() p: CurrentPropertyT) {
    return this.shifts.current(p.id);
  }

  @Post('shifts')
  @RequirePermission('pos.shift')
  @Idempotent()
  openShift(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(OpenShift)) b: Body<typeof OpenShift>) {
    return this.shifts.open(p.id, b);
  }

  @Post('shifts/current/movements')
  @RequirePermission('pos.shift')
  @Idempotent()
  movement(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(Movement)) b: Body<typeof Movement>) {
    return this.shifts.movement(p.id, b);
  }

  @Post('shifts/:shiftId/close')
  @HttpCode(200)
  @RequirePermission('pos.shift')
  @Idempotent()
  closeShift(@CurrentProperty() p: CurrentPropertyT, @Param('shiftId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CloseShift)) b: Body<typeof CloseShift>) {
    return this.shifts.close(p.id, id, b);
  }

  @Get('shifts')
  @RequirePermission('pos.report')
  listShifts(
    @CurrentProperty() p: CurrentPropertyT,
    @Query('outlet') outletCode?: string,
    @Query('status') status?: string,
    @Query('unreviewed') unreviewed?: string,
  ) {
    return this.shifts.list(p.id, {
      outletCode,
      status: status === 'open' || status === 'closed' ? status : undefined,
      unreviewed: unreviewed === 'true',
    });
  }

  @Get('shifts/:shiftId')
  @RequirePermission('pos.report')
  getShift(@CurrentProperty() p: CurrentPropertyT, @Param('shiftId', ParseUUIDPipe) id: string) {
    return this.shifts.get(p.id, id);
  }

  @Post('shifts/:shiftId/review')
  @HttpCode(200)
  @RequirePermission('pos.report')
  @Idempotent()
  review(@CurrentProperty() p: CurrentPropertyT, @Param('shiftId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReviewShift)) b: Body<typeof ReviewShift>) {
    return this.shifts.review(p.id, id, b);
  }

  @Get('outlets/:outletCode/days')
  @RequirePermission('pos.report')
  days_(@CurrentProperty() p: CurrentPropertyT, @Param('outletCode') outletCode: string) {
    return this.days.days(p.id, outletCode);
  }

  @Get('days/:dayId')
  @RequirePermission('pos.report')
  day(@CurrentProperty() p: CurrentPropertyT, @Param('dayId', ParseUUIDPipe) id: string) {
    return this.days.day(p.id, id);
  }

  @Get('days/:dayId/print')
  @RequirePermission('pos.report')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async printDay(@CurrentProperty() p: CurrentPropertyT, @Param('dayId', ParseUUIDPipe) id: string) {
    return renderDayReport(await this.days.day(p.id, id), await this.folios.headerFor(p.id));
  }

  @Post('outlets/:outletCode/close-day')
  @HttpCode(200)
  @RequirePermission('pos.day_close')
  @Idempotent()
  closeDay(@CurrentProperty() p: CurrentPropertyT, @Param('outletCode') outletCode: string, @Body(new ZodPipe(CloseDay)) b: Body<typeof CloseDay>) {
    return this.days.closeDay(p.id, outletCode, b.businessDate);
  }

  @Get('reports/sales')
  @RequirePermission('pos.report')
  sales(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(SalesQuery)) query: Body<typeof SalesQuery>) {
    return this.reports.sales(p.id, { from: query.from, to: query.to, outletCode: query.outlet });
  }
}

// ---------------------------------------------------------------------------
// Outlet price lists, house accounts and settings (POS-03, POS-12, POS-18, POS-19, CFG-01, CFG-03)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode/pos')
@PropertyScoped()
export class PosAdminController {
  constructor(
    private readonly menu: PosMenuService,
    private readonly settings: PosSettingsService,
  ) {}

  @Patch('outlets/:outletCode/prices/:priceId')
  @RequirePermission('pos.menu.manage')
  @Idempotent()
  updatePrice(
    @CurrentProperty() p: CurrentPropertyT,
    @Param('outletCode') outletCode: string,
    @Param('priceId', ParseUUIDPipe) priceId: string,
    @Body(new ZodPipe(UpdatePrice)) b: Body<typeof UpdatePrice>,
  ) {
    return this.menu.updatePrice(p.id, outletCode, priceId, b);
  }

  /** 86 an item, or bring it back (POS-12). Supervisors and kitchen can do this mid-service. */
  @Post('outlets/:outletCode/prices/:priceId/availability')
  @HttpCode(200)
  @RequirePermission('pos.availability')
  @Idempotent()
  availability(
    @CurrentProperty() p: CurrentPropertyT,
    @Param('outletCode') outletCode: string,
    @Param('priceId', ParseUUIDPipe) priceId: string,
    @Body(new ZodPipe(Availability)) b: Body<typeof Availability>,
  ) {
    return this.menu.setAvailability(p.id, outletCode, priceId, b.isAvailable);
  }

  @Post('outlets/:outletCode/prices')
  @RequirePermission('pos.menu.manage')
  @Idempotent()
  addToOutlet(@CurrentProperty() p: CurrentPropertyT, @Param('outletCode') outletCode: string, @Body(new ZodPipe(AddToOutlet)) b: Body<typeof AddToOutlet>) {
    return this.menu.addToOutlet(p.id, outletCode, b);
  }

  @Get('house-accounts')
  @RequirePermission('pos.use')
  houseAccounts(@CurrentProperty() p: CurrentPropertyT) {
    return this.menu.houseAccounts(p.id);
  }

  @Post('house-accounts')
  @RequirePermission('pos.menu.manage')
  @Idempotent()
  createHouseAccount(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(HouseAccount)) b: Body<typeof HouseAccount>) {
    return this.menu.createHouseAccount(p.id, b);
  }

  @Get('settings')
  @RequirePermission('pos.report')
  getSettings(@CurrentProperty() p: CurrentPropertyT) {
    return this.settings.get(p.id);
  }

  @Put('settings')
  @RequirePermission('businessday.configure')
  @Idempotent()
  updateSettings(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(PropertySettings)) b: Body<typeof PropertySettings>) {
    return this.settings.updateProperty(p.id, b);
  }

  @Put('outlets/:outletCode/settings')
  @RequirePermission('businessday.configure')
  @Idempotent()
  updateOutlet(@CurrentProperty() p: CurrentPropertyT, @Param('outletCode') outletCode: string, @Body(new ZodPipe(OutletSettings)) b: Body<typeof OutletSettings>) {
    return this.settings.updateOutlet(p.id, outletCode, b);
  }
}

// ---------------------------------------------------------------------------
// Group menu (CFG-05, POS-02) and outlet templates (POS-19): across properties
// ---------------------------------------------------------------------------
@Controller('pos')
export class PosMenuController {
  constructor(private readonly menu: PosMenuService) {}

  @Get('menu')
  @RequirePermission('pos.menu.read')
  groupMenu() {
    return this.menu.groupMenu();
  }

  @Post('menu/items')
  @RequirePermission('pos.menu.manage')
  @Idempotent()
  createItem(@Body(new ZodPipe(CreateItem)) b: Body<typeof CreateItem>) {
    return this.menu.createItem(b);
  }

  @Post('outlets/copy')
  @HttpCode(200)
  @RequirePermission('pos.menu.manage')
  @Idempotent()
  copy(@Body(new ZodPipe(CopyOutlet)) b: Body<typeof CopyOutlet>) {
    return this.menu.copyOutlet(b.fromOutletCode, b.toOutletCode);
  }
}
