import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  BOOKING_SOURCES,
  GUEST_REQUEST_CATEGORIES,
  GUEST_REQUEST_STATUSES,
  HK_STATUSES,
  IDENTITY_DOCUMENT_TYPES,
  nightsBetween,
  PAYMENT_TENDERS,
  STAY_STATUSES,
} from '@hotel/shared';
import { z } from 'zod';
import { CurrentProperty, PropertyScoped, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { Idempotent } from '../idempotency/idempotency';
import { Amount, ApprovalInput, CurrentPropertyT, IsoDate, Quantity, Reason, Time } from './common';
import { FoliosService } from './folios.service';
import { FrontDeskService } from './frontdesk.service';
import { GuestsService } from './guests.service';
import { RatesService } from './rates.service';
import { renderDocument, renderRegistrationCard, renderStatement } from './render';
import { ReservationsService } from './reservations.service';
import { RoomsService } from './rooms.service';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const Country = z.string().regex(/^[A-Za-z]{2}$/, 'ISO country code, e.g. KE');
const GuestSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().email().nullish(),
  phone: z.string().regex(/^\+?[0-9 ]{7,20}$/).nullish(),
  nationality: Country.nullish(),
  dateOfBirth: IsoDate.nullish(),
  address: z.string().max(300).nullish(),
  companyId: z.string().uuid().nullish(),
  preferences: z.string().max(1000).nullish(),
  notes: z.string().max(1000).nullish(),
  marketingConsent: z.boolean().optional(),
});
const GuestRef = z.union([z.object({ id: z.string().uuid() }).strict(), GuestSchema]);
const IdentitySchema = z.object({
  documentType: z.enum(IDENTITY_DOCUMENT_TYPES),
  documentNumber: z.string().trim().min(3).max(40),
  issuingCountry: Country,
  expiryDate: IsoDate.nullish(),
});
const RateOverride = z.object({ amountPerNight: Amount, reason: Reason });

const CreateReservation = z.object({
  source: z.enum(BOOKING_SOURCES),
  agentId: z.string().uuid().nullish(),
  agentReference: z.string().max(60).nullish(),
  companyId: z.string().uuid().nullish(),
  notes: z.string().max(2000).nullish(),
  guest: GuestRef,
  arrival: IsoDate,
  departure: IsoDate,
  status: z.enum(['enquiry', 'hold', 'confirmed']).default('confirmed'),
  holdMinutes: z.number().int().min(5).max(20160).optional(),
  rooms: z
    .array(
      z.object({
        roomTypeCode: z.string().min(2).max(8),
        ratePlanCode: z.string().min(2).max(12),
        adults: z.number().int().min(1).max(12),
        children: z.number().int().min(0).max(12).default(0),
        roomId: z.string().uuid().nullish(),
        guest: GuestRef.optional(),
        rateOverride: RateOverride.optional(),
        notes: z.string().max(1000).nullish(),
      }),
    )
    .min(1)
    .max(20),
  approval: ApprovalInput,
});

const Lifecycle = z.object({
  stayIds: z.array(z.string().uuid()).min(1).optional(),
  holdMinutes: z.number().int().min(5).max(20160).optional(),
  reason: Reason.optional(),
  waiveFee: z.boolean().optional(),
  approval: ApprovalInput,
});

const Amend = z.object({
  arrival: IsoDate.optional(),
  departure: IsoDate.optional(),
  roomTypeCode: z.string().min(2).max(8).optional(),
  ratePlanCode: z.string().min(2).max(12).optional(),
  adults: z.number().int().min(1).max(12).optional(),
  children: z.number().int().min(0).max(12).optional(),
  roomId: z.string().uuid().nullish(),
  rateOverride: RateOverride.optional(),
  reason: Reason,
  approval: ApprovalInput,
});

const Registration = z.object({
  method: z.enum(['paper_signature', 'digital_signature', 'staff_verified']),
  signedName: z.string().trim().min(2).max(120),
  signature: z.string().max(200000).nullish(),
});

const CheckIn = z.object({
  roomId: z.string().uuid().nullish(),
  identity: IdentitySchema.optional(),
  occupants: z.array(GuestRef).max(11).optional(),
  roomChargeAllowed: z.boolean(),
  creditLimit: Amount.nullish(),
  earlyCheckIn: z.boolean().optional(),
  waiveFee: z.boolean().optional(),
  roomNotReadyReason: Reason.optional(),
  registration: Registration.optional(),
  approval: ApprovalInput,
});

const Tender = z.object({
  tender: z.enum(PAYMENT_TENDERS),
  amount: Amount,
  reference: z.string().trim().min(3).max(60).nullish(),
  status: z.enum(['pending', 'confirmed']).optional(),
});

const CheckOut = z.object({
  tenders: z.array(Tender).max(10).optional(),
  creditTransfer: z.object({ companyId: z.string().uuid(), reason: Reason }).optional(),
  approval: ApprovalInput,
});

const Move = z.object({ toRoomId: z.string().uuid(), reason: Reason, roomNotReadyReason: Reason.optional(), approval: ApprovalInput });
const LateCheckout = z.object({ departureTime: Time, waiveFee: z.boolean().optional(), reason: Reason.optional(), approval: ApprovalInput });
const CloseDay = z.object({ businessDate: IsoDate });

const Charge = z.object({
  chargeCode: z.string().regex(/^[A-Z_]{2,20}$/),
  description: z.string().trim().max(200).optional(),
  quantity: Quantity.default('1'),
  unitPrice: Amount,
  discount: Amount.optional(),
  outletCode: z.string().max(16).optional(),
  reference: z.string().max(60).optional(),
});
const Reverse = z.object({ reason: Reason, approval: ApprovalInput });
const Payments = z.object({ tenders: z.array(Tender.refine((t) => t.tender !== 'city_ledger', 'city_ledger is only used at checkout')).min(1).max(10) });
const Fail = z.object({ reason: Reason });

const Block = z.object({ from: IsoDate, to: IsoDate, reason: Reason });
const HkStatus = z.object({ hkStatus: z.enum(HK_STATUSES) });
const AvailabilityQuery = z.object({ from: IsoDate, days: z.coerce.number().int().min(1).max(62).default(7) });
const FreeRoomsQuery = z.object({ roomTypeCode: z.string().min(2).max(8).optional(), arrival: IsoDate, departure: IsoDate });
const ListQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), status: z.enum(STAY_STATUSES).optional(), q: z.string().max(80).optional() });
const Quote = z.object({ roomTypeCode: z.string(), ratePlanCode: z.string(), arrival: IsoDate, departure: IsoDate, adults: z.number().int().min(1), children: z.number().int().min(0).default(0) });
const NewPrice = z.object({
  roomTypeCode: z.string().min(2).max(8),
  seasonName: z.string().trim().min(2).max(60),
  validFrom: IsoDate,
  validTo: IsoDate.nullish(),
  priority: z.number().int().min(0).max(100).default(10),
  weekdayPrice: Amount,
  weekendPrice: Amount,
  extraAdultPrice: Amount.default('0'),
  childPrice: Amount.default('0'),
});
const Policy = z
  .object({
    depositType: z.enum(['none', 'percent', 'nights']),
    depositValue: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/),
    depositDueDays: z.number().int().min(0).max(365),
    holdMinutes: z.number().int().min(5).max(20160),
    freeCancellationHours: z.number().int().min(0).max(8760),
    lateCancellationNights: z.number().int().min(0).max(30),
    noShowNights: z.number().int().min(0).max(30),
    refundPolicy: z.string().max(2000),
    checkInTime: Time,
    checkOutTime: Time,
    earlyCheckInFee: Amount,
    lateCheckOutFee: Amount,
    registrationTerms: z.string().max(5000),
  })
  .partial();
const RequestSchema = z.object({
  stayId: z.string().uuid().nullish(),
  roomId: z.string().uuid().nullish(),
  category: z.enum(GUEST_REQUEST_CATEGORIES),
  description: z.string().trim().min(3).max(1000),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  ownerUserId: z.string().uuid().nullish(),
  dueAt: z.string().datetime({ offset: true }).nullish(),
});
const RequestUpdate = z.object({
  status: z.enum(GUEST_REQUEST_STATUSES).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  note: z.string().trim().min(1).max(1000).optional(),
});

type Body<S extends z.ZodTypeAny> = z.infer<S>;

// ---------------------------------------------------------------------------
// Rooms, availability, rates and policies (CFG-02, RES-01, RES-05, RES-07)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode')
@PropertyScoped()
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly rates: RatesService,
  ) {}

  @Get('room-types')
  @RequirePermission('room.read')
  roomTypes(@CurrentProperty() p: CurrentPropertyT) {
    return this.rooms.listRoomTypes(p.id);
  }

  @Get('rooms')
  @RequirePermission('room.read')
  list(@CurrentProperty() p: CurrentPropertyT) {
    return this.rooms.listRooms(p.id, p.businessDate);
  }

  @Patch('rooms/:roomId/hk-status')
  @RequirePermission('room.status')
  hk(@CurrentProperty() p: CurrentPropertyT, @Param('roomId', ParseUUIDPipe) roomId: string, @Body(new ZodPipe(HkStatus)) b: Body<typeof HkStatus>) {
    return this.rooms.setHkStatus(p.id, roomId, b.hkStatus);
  }

  @Post('rooms/:roomId/blocks')
  @RequirePermission('room.block')
  @Idempotent()
  block(@CurrentProperty() p: CurrentPropertyT, @Param('roomId', ParseUUIDPipe) roomId: string, @Body(new ZodPipe(Block)) b: Body<typeof Block>) {
    return this.rooms.block(p.id, roomId, b.from, b.to, b.reason);
  }

  @Post('blocks/:blockId/release')
  @HttpCode(200)
  @RequirePermission('room.block')
  release(@CurrentProperty() p: CurrentPropertyT, @Param('blockId', ParseUUIDPipe) blockId: string) {
    return this.rooms.releaseBlock(p.id, blockId);
  }

  @Get('availability')
  @RequirePermission('reservation.read')
  availability(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(AvailabilityQuery)) qy: Body<typeof AvailabilityQuery>) {
    return this.rooms.availability(p.id, qy.from, qy.days);
  }

  @Get('availability/rooms')
  @RequirePermission('reservation.read')
  async freeRooms(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(FreeRoomsQuery)) qy: Body<typeof FreeRoomsQuery>) {
    return this.rooms.freeRoomsFor(p.id, qy.roomTypeCode ?? null, qy.arrival, qy.departure);
  }

  @Get('rate-plans')
  @RequirePermission('rate.read')
  plans(@CurrentProperty() p: CurrentPropertyT) {
    return this.rates.listPlans(p.id);
  }

  @Post('rate-plans/:planCode/prices')
  @RequirePermission('rate.manage')
  @Idempotent()
  addPrice(@CurrentProperty() p: CurrentPropertyT, @Param('planCode') planCode: string, @Body(new ZodPipe(NewPrice)) b: Body<typeof NewPrice>) {
    return this.rates.addPrice(p.id, planCode, b);
  }

  @Post('rates/quote')
  @HttpCode(200)
  @RequirePermission('rate.read')
  quote(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(Quote)) b: Body<typeof Quote>) {
    return this.rates.quote(p.id, { ...b, nights: nightsBetween(b.arrival, b.departure) });
  }

  @Get('policy')
  @RequirePermission('rate.read')
  policy(@CurrentProperty() p: CurrentPropertyT) {
    return this.rates.getPolicy(p.id);
  }

  @Put('policy')
  @RequirePermission('policy.manage')
  updatePolicy(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(Policy)) b: Body<typeof Policy>) {
    return this.rates.updatePolicy(p.id, b);
  }
}

// ---------------------------------------------------------------------------
// Reservations (RES-02 … RES-08, BIL-09 pro forma)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode/reservations')
@PropertyScoped()
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @RequirePermission('reservation.read')
  list(@CurrentProperty() p: CurrentPropertyT, @Query(new ZodPipe(ListQuery)) qy: Body<typeof ListQuery>) {
    return this.reservations.list(p.id, qy);
  }

  @Post()
  @RequirePermission('reservation.manage')
  @Idempotent()
  create(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(CreateReservation)) b: Body<typeof CreateReservation>) {
    return this.reservations.create(p, b);
  }

  @Get(':id')
  @RequirePermission('reservation.read')
  get(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.get(p.id, id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission('reservation.manage')
  @Idempotent()
  confirm(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Lifecycle)) b: Body<typeof Lifecycle>) {
    return this.reservations.lifecycle(p.id, id, 'confirm', b);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @RequirePermission('reservation.manage')
  @Idempotent()
  hold(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Lifecycle)) b: Body<typeof Lifecycle>) {
    return this.reservations.lifecycle(p.id, id, 'hold', b);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('reservation.manage')
  @Idempotent()
  cancel(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Lifecycle)) b: Body<typeof Lifecycle>) {
    return this.reservations.lifecycle(p.id, id, 'cancel', b);
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @RequirePermission('frontdesk.operate')
  @Idempotent()
  noShow(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Lifecycle)) b: Body<typeof Lifecycle>) {
    return this.reservations.lifecycle(p.id, id, 'no_show', b);
  }

  @Post(':id/proforma')
  @RequirePermission('reservation.manage')
  @Idempotent()
  proforma(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.proforma(p.id, id);
  }
}

// ---------------------------------------------------------------------------
// Front desk (FD-01 … FD-08)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode')
@PropertyScoped()
export class FrontDeskController {
  constructor(
    private readonly desk: FrontDeskService,
    private readonly reservations: ReservationsService,
  ) {}

  @Get('front-desk/dashboard')
  @RequirePermission('reservation.read')
  dashboard(@CurrentProperty() p: CurrentPropertyT) {
    return this.desk.dashboard(p.id);
  }

  @Post('front-desk/close-day')
  @HttpCode(200)
  @RequirePermission('businessday.close')
  @Idempotent()
  closeDay(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(CloseDay)) b: Body<typeof CloseDay>) {
    return this.desk.closeDay(p.id, b.businessDate);
  }

  @Get('staff')
  @RequirePermission('guest_request.manage')
  staff(@CurrentProperty() p: CurrentPropertyT) {
    return this.desk.staff(p.id);
  }

  @Post('stays/:stayId/amend')
  @HttpCode(200)
  @RequirePermission('reservation.manage')
  @Idempotent()
  amend(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string, @Body(new ZodPipe(Amend)) b: Body<typeof Amend>) {
    return this.reservations.amend(p.id, stayId, b);
  }

  @Post('stays/:stayId/check-in')
  @HttpCode(200)
  @RequirePermission('frontdesk.operate')
  @Idempotent()
  checkIn(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string, @Body(new ZodPipe(CheckIn)) b: Body<typeof CheckIn>) {
    return this.desk.checkIn(p.id, stayId, b);
  }

  @Get('stays/:stayId/registration-card')
  @RequirePermission('frontdesk.operate')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async registrationCard(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string) {
    return renderRegistrationCard(await this.desk.registrationCard(p.id, stayId));
  }

  @Post('stays/:stayId/registration-card/acknowledge')
  @HttpCode(200)
  @RequirePermission('frontdesk.operate')
  @Idempotent()
  acknowledge(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string, @Body(new ZodPipe(Registration)) b: Body<typeof Registration>) {
    return this.desk.acknowledgeRegistration(p.id, stayId, b);
  }

  @Post('stays/:stayId/move')
  @HttpCode(200)
  @RequirePermission('frontdesk.operate')
  @Idempotent()
  move(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string, @Body(new ZodPipe(Move)) b: Body<typeof Move>) {
    return this.desk.move(p.id, stayId, b);
  }

  @Get('stays/:stayId/moves')
  @RequirePermission('reservation.read')
  moves(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string) {
    return this.desk.moves(p.id, stayId);
  }

  @Post('stays/:stayId/late-checkout')
  @HttpCode(200)
  @RequirePermission('frontdesk.operate')
  @Idempotent()
  lateCheckout(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string, @Body(new ZodPipe(LateCheckout)) b: Body<typeof LateCheckout>) {
    return this.desk.lateCheckout(p.id, stayId, b);
  }

  @Post('stays/:stayId/check-out')
  @HttpCode(200)
  @RequirePermission('frontdesk.operate')
  @Idempotent()
  checkOut(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string, @Body(new ZodPipe(CheckOut)) b: Body<typeof CheckOut>) {
    return this.desk.checkOut(p.id, stayId, b);
  }

  @Get('guest-requests')
  @RequirePermission('guest_request.manage')
  requests(@CurrentProperty() p: CurrentPropertyT, @Query('status') status?: string) {
    return this.desk.listRequests(p.id, status && (GUEST_REQUEST_STATUSES as readonly string[]).includes(status) ? status : undefined);
  }

  @Post('guest-requests')
  @RequirePermission('guest_request.manage')
  @Idempotent()
  createRequest(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(RequestSchema)) b: Body<typeof RequestSchema>) {
    return this.desk.createRequest(p.id, b);
  }

  @Patch('guest-requests/:id')
  @RequirePermission('guest_request.manage')
  updateRequest(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RequestUpdate)) b: Body<typeof RequestUpdate>) {
    return this.desk.updateRequest(p.id, id, b);
  }
}

// ---------------------------------------------------------------------------
// Folios, payments and documents (BIL-01, BIL-06, BIL-09)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode')
@PropertyScoped()
export class FoliosController {
  constructor(private readonly folios: FoliosService) {}

  @Get('folios/:folioId')
  @RequirePermission('folio.read')
  get(@CurrentProperty() p: CurrentPropertyT, @Param('folioId', ParseUUIDPipe) folioId: string) {
    return this.folios.get(p.id, folioId);
  }

  @Get('folios/:folioId/statement')
  @RequirePermission('folio.read')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async statement(@CurrentProperty() p: CurrentPropertyT, @Param('folioId', ParseUUIDPipe) folioId: string) {
    const folio = await this.folios.get(p.id, folioId);
    return renderStatement(folio, await this.folios.headerFor(p.id));
  }

  @Post('folios/:folioId/charges')
  @RequirePermission('folio.charge')
  @Idempotent()
  charge(@CurrentProperty() p: CurrentPropertyT, @Param('folioId', ParseUUIDPipe) folioId: string, @Body(new ZodPipe(Charge)) b: Body<typeof Charge>) {
    return this.folios.postManualCharge(p.id, folioId, b);
  }

  @Post('folios/:folioId/charges/:chargeId/reverse')
  @RequirePermission('folio.charge')
  @Idempotent()
  reverse(
    @CurrentProperty() p: CurrentPropertyT,
    @Param('folioId', ParseUUIDPipe) folioId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body(new ZodPipe(Reverse)) b: Body<typeof Reverse>,
  ) {
    return this.folios.reverseCharge(p.id, folioId, chargeId, b.reason, b.approval);
  }

  @Post('folios/:folioId/payments')
  @RequirePermission('payment.take')
  @Idempotent()
  pay(@CurrentProperty() p: CurrentPropertyT, @Param('folioId', ParseUUIDPipe) folioId: string, @Body(new ZodPipe(Payments)) b: Body<typeof Payments>) {
    return this.folios.takePayments(p.id, folioId, b.tenders);
  }

  @Post('payments/:paymentId/confirm')
  @HttpCode(200)
  @RequirePermission('payment.confirm')
  @Idempotent()
  confirm(@CurrentProperty() p: CurrentPropertyT, @Param('paymentId', ParseUUIDPipe) paymentId: string) {
    return this.folios.confirmPayment(p.id, paymentId);
  }

  @Post('payments/:paymentId/fail')
  @HttpCode(200)
  @RequirePermission('payment.confirm')
  @Idempotent()
  fail(@CurrentProperty() p: CurrentPropertyT, @Param('paymentId', ParseUUIDPipe) paymentId: string, @Body(new ZodPipe(Fail)) b: Body<typeof Fail>) {
    return this.folios.failPayment(p.id, paymentId, b.reason);
  }

  @Get('documents/:id')
  @RequirePermission('folio.read')
  document(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string) {
    return this.folios.document(p.id, id);
  }

  @Get('documents/:id/html')
  @RequirePermission('folio.read')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async documentHtml(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string) {
    return renderDocument(await this.folios.document(p.id, id));
  }
}

// ---------------------------------------------------------------------------
// Guests and companies, shared across the group (CFG-05, FD-02)
// ---------------------------------------------------------------------------
@Controller()
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Get('guests')
  @RequirePermission('guest.read')
  search(@Query('q') q = '') {
    return this.guests.search(q);
  }

  @Post('guests')
  @RequirePermission('guest.manage')
  create(@Body(new ZodPipe(GuestSchema)) b: Body<typeof GuestSchema>) {
    return this.guests.createGuest(b);
  }

  @Get('guests/:id')
  @RequirePermission('guest.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.guests.get(id);
  }

  @Patch('guests/:id')
  @RequirePermission('guest.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(GuestSchema.partial())) b: Partial<Body<typeof GuestSchema>>) {
    return this.guests.update(id, b);
  }

  @Get('guests/:id/identity-documents')
  @RequirePermission('guest.identity')
  identity(@Param('id', ParseUUIDPipe) id: string) {
    return this.guests.identityDocuments(id);
  }

  @Post('guests/:id/identity-documents')
  @RequirePermission('guest.identity')
  addIdentity(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(IdentitySchema)) b: Body<typeof IdentitySchema>) {
    return this.guests.addIdentityDocument(id, b);
  }

  @Get('companies')
  @RequirePermission('guest.read')
  companies(@Query('kind') kind?: string) {
    return this.guests.companies(kind === 'company' || kind === 'agent' ? kind : undefined);
  }
}
