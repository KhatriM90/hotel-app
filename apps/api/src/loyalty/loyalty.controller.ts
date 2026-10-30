import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentProperty, Public, PropertyScoped, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { ApprovalInput, CurrentPropertyT, IsoDate, Reason, SignedAmount } from '../frontoffice/common';
import { Idempotent } from '../idempotency/idempotency';
import { CashbackService } from './cashback.service';
import { LoyaltyCheckoutService } from './checkout.service';
import { LoyaltyMembersService } from './members.service';
import { LoyaltyProgrammeService, SettingsSchema } from './programme.service';
import { renderCard, renderSelfService } from './render';
import { LoyaltyReportsService } from './reports.service';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
type Body<S extends z.ZodTypeAny> = z.infer<S>;
const Uuid = z.string().uuid();
const Percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) <= 100, 'at most 100');
const Phone = z.string().trim().regex(/^\+?[\d ]{9,16}$/, 'expected a phone number such as +254 712 345 678');
const Month = z.string().regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM');

const Enrol = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  phone: Phone,
  email: z.string().trim().email().max(120).nullish(),
  guestId: Uuid.nullish(),
  companyId: Uuid.nullish(),
  kind: z.enum(['individual', 'corporate']).optional(),
  adultConfirmed: z.literal(true, { errorMap: () => ({ message: 'Members must be 18 or over' }) }),
  programmeAccepted: z.literal(true, { errorMap: () => ({ message: 'The member must accept the programme terms' }) }),
  marketingConsent: z.boolean().optional(),
  channel: z.enum(['reception', 'pos']),
  outletCode: z.string().regex(/^[A-Za-z0-9-]{2,24}$/).nullish(),
  confirmNotDuplicate: z.boolean().optional(),
});
const UpdateMember = z.object({
  phone: Phone.optional(),
  email: z.string().trim().email().max(120).nullable().optional(),
  marketingConsent: z.boolean().optional(),
  status: z.enum(['active', 'suspended', 'closed']).optional(),
});
const RequestOtp = z.object({ purpose: z.enum(['redeem', 'enrol']), checkId: Uuid.nullish() });
const VerifyOtp = z.object({ code: z.string().regex(/^\d{4,8}$/) });
const VerifyQr = z.object({ qr: z.string().min(10).max(200), checkId: Uuid.nullish() });
const Adjust = z.object({ unit: z.enum(['points', 'wallet']), amount: SignedAmount, reason: Reason, approval: ApprovalInput });
const Merge = z.object({ fromMemberId: Uuid, reason: Reason, approval: ApprovalInput });
const Staff = z.object({ username: z.string().trim().min(2).max(60).nullable(), reason: Reason });
const Anonymise = z.object({ reason: Reason, approval: ApprovalInput });
const Club = z.object({
  tierCode: z.string().regex(/^[A-Z0-9_]{2,20}$/),
  status: z.enum(['active', 'suspended', 'expired']),
  startsOn: IsoDate,
  endsOn: IsoDate.nullish(),
  reason: Reason,
});
const Override = z.object({
  discountPercent: Percent.nullable(),
  cashbackPercent: Percent.nullable(),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullish(),
  reason: Reason,
  approval: ApprovalInput,
});
const AttachMember = z.object({ memberId: Uuid.nullable() });
const Benefit = z.object({ benefit: z.enum(['discount', 'cashback']) });
const Redeem = z.object({
  points: z.number().int().min(0).max(10_000_000).optional(),
  wallet: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/).optional(),
  verificationId: Uuid,
});
const CompanyPaid = z.object({ reason: Reason });
const Version = z.object({ settings: SettingsSchema, effectiveFrom: z.string().datetime({ offset: true }).nullish(), note: Reason });
const TierRate = z.object({ discountPercent: Percent.nullable(), cashbackPercent: Percent.nullable(), effectiveFrom: z.string().datetime({ offset: true }).nullish(), reason: Reason });
const Generate = z.object({ month: Month, note: z.string().trim().max(500).nullish() });
const Approve = z.object({ reason: Reason, approval: ApprovalInput });
const Discard = z.object({ reason: Reason });

// ---------------------------------------------------------------------------
// Members at a property: enrolment, lookup, verification, corrections (LOY11, LOY15, LOY23, LOY24)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode/loyalty')
@PropertyScoped()
export class LoyaltyMembersController {
  constructor(
    private readonly members: LoyaltyMembersService,
    private readonly checkout: LoyaltyCheckoutService,
  ) {}

  @Get('members')
  @RequirePermission('loyalty.lookup')
  lookup(@Query('q') q = '') {
    return this.members.lookup(q);
  }

  @Post('members')
  @RequirePermission('loyalty.enrol')
  @Idempotent()
  enrol(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(Enrol)) b: Body<typeof Enrol>) {
    return this.members.enrol(p.id, b);
  }

  @Get('members/:memberId')
  @RequirePermission('loyalty.lookup')
  get(@Param('memberId', ParseUUIDPipe) id: string) {
    return this.members.get(id);
  }

  @Get('members/:memberId/history')
  @RequirePermission('loyalty.lookup')
  history(@Param('memberId', ParseUUIDPipe) id: string, @Query('unit') unit?: string) {
    return this.members.history(id, unit === 'points' || unit === 'wallet' ? unit : undefined);
  }

  @Get('members/:memberId/card')
  @RequirePermission('loyalty.lookup')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async card(@Param('memberId', ParseUUIDPipe) id: string) {
    return renderCard(await this.members.cardData(id));
  }

  @Patch('members/:memberId')
  @RequirePermission('loyalty.manage')
  @Idempotent()
  update(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateMember)) b: Body<typeof UpdateMember>) {
    return this.members.update(p.id, id, b);
  }

  @Post('members/:memberId/otp')
  @RequirePermission('loyalty.lookup')
  @Idempotent()
  requestOtp(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(RequestOtp)) b: Body<typeof RequestOtp>) {
    return this.members.requestOtp(p.id, id, b);
  }

  @Post('verifications/:verificationId/verify')
  @HttpCode(200)
  @RequirePermission('loyalty.lookup')
  verifyOtp(@Param('verificationId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VerifyOtp)) b: Body<typeof VerifyOtp>) {
    return this.members.verifyOtp(id, b.code);
  }

  @Post('members/:memberId/verify-card')
  @HttpCode(200)
  @RequirePermission('loyalty.lookup')
  verifyCard(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(VerifyQr)) b: Body<typeof VerifyQr>) {
    return this.members.verifyQr(p.id, id, b.qr, b.checkId);
  }

  @Post('members/:memberId/adjust')
  @RequirePermission('loyalty.manage')
  @Idempotent()
  adjust(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Adjust)) b: Body<typeof Adjust>) {
    return this.members.adjust(p.id, id, b);
  }

  @Post('members/:memberId/merge')
  @RequirePermission('loyalty.manage')
  @Idempotent()
  merge(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Merge)) b: Body<typeof Merge>) {
    return this.members.merge(p.id, id, b);
  }

  @Post('members/:memberId/staff')
  @RequirePermission('loyalty.manage')
  @Idempotent()
  staff(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Staff)) b: Body<typeof Staff>) {
    return this.members.flagStaff(p.id, id, b);
  }

  @Post('members/:memberId/anonymise')
  @RequirePermission('loyalty.manage')
  @Idempotent()
  anonymise(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Anonymise)) b: Body<typeof Anonymise>) {
    return this.members.anonymise(p.id, id, b);
  }

  @Put('members/:memberId/club')
  @RequirePermission('loyalty.club.manage')
  @Idempotent()
  club(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Club)) b: Body<typeof Club>) {
    return this.members.setClub(p.id, id, b);
  }

  @Post('members/:memberId/club/overrides')
  @RequirePermission('loyalty.club.manage')
  @Idempotent()
  override(@CurrentProperty() p: CurrentPropertyT, @Param('memberId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Override)) b: Body<typeof Override>) {
    return this.members.addOverride(p.id, id, b);
  }

  /** Finance confirms a company (city ledger) paid: the folio's pending points are released (LAT08). */
  @Post('folios/:folioId/company-paid')
  @HttpCode(200)
  @RequirePermission('loyalty.finance')
  @Idempotent()
  companyPaid(@CurrentProperty() p: CurrentPropertyT, @Param('folioId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CompanyPaid)) b: Body<typeof CompanyPaid>) {
    return this.checkout.confirmCompanyPayment(p.id, id, b.reason);
  }
}

// ---------------------------------------------------------------------------
// Member on a POS check: attach, choose club benefit, preview and redeem (LOY12, LOY13, LOY17, CLUB02)
// ---------------------------------------------------------------------------
@Controller('properties/:propertyCode/pos/checks/:checkId/loyalty')
@PropertyScoped()
export class LoyaltyCheckController {
  constructor(
    private readonly db: DbService,
    private readonly checkout: LoyaltyCheckoutService,
  ) {}

  @Get()
  @RequirePermission('pos.use')
  preview(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string) {
    return this.db.tx((q) => this.checkout.preview(q, p.id, id));
  }

  @Put('member')
  @RequirePermission('loyalty.lookup')
  @Idempotent()
  attach(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(AttachMember)) b: Body<typeof AttachMember>) {
    return this.db.tx(async (q) => {
      await this.checkout.attach(q, p.id, id, b.memberId);
      return this.checkout.preview(q, p.id, id);
    });
  }

  @Put('benefit')
  @RequirePermission('loyalty.lookup')
  @Idempotent()
  benefit(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Benefit)) b: Body<typeof Benefit>) {
    return this.db.tx(async (q) => {
      await this.checkout.setBenefit(q, p.id, id, b.benefit);
      return this.checkout.preview(q, p.id, id);
    });
  }

  @Post('rewards')
  @HttpCode(200)
  @RequirePermission('loyalty.redeem')
  @Idempotent()
  redeem(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Redeem)) b: Body<typeof Redeem>) {
    return this.db.tx(async (q) => {
      await this.checkout.applyRewards(q, p.id, id, b);
      return this.checkout.preview(q, p.id, id);
    });
  }

  @Post('rewards/remove')
  @HttpCode(200)
  @RequirePermission('pos.use')
  @Idempotent()
  removeRewards(@CurrentProperty() p: CurrentPropertyT, @Param('checkId', ParseUUIDPipe) id: string) {
    return this.db.tx(async (q) => {
      await this.checkout.removeRewards(q, p.id, id);
      return this.checkout.preview(q, p.id, id);
    });
  }
}

// ---------------------------------------------------------------------------
// Group-wide: programme settings, month-end cashback and reports (LOY01, CLUB01, CLUB03, CLUB04, LOY19, LOY21, LOY22)
// ---------------------------------------------------------------------------
@Controller('loyalty')
export class LoyaltyAdminController {
  constructor(
    private readonly members: LoyaltyMembersService,
    private readonly programme: LoyaltyProgrammeService,
    private readonly cashback: CashbackService,
    private readonly reports: LoyaltyReportsService,
  ) {}

  @Get('programme')
  @RequirePermission('loyalty.read')
  overview() {
    return this.programme.overview();
  }

  @Post('programme/versions')
  @RequirePermission('loyalty.programme')
  @Idempotent()
  createVersion(@Body(new ZodPipe(Version)) b: Body<typeof Version>) {
    return this.programme.createVersion(b as Parameters<LoyaltyProgrammeService['createVersion']>[0]);
  }

  @Put('programme/tiers/:code')
  @RequirePermission('loyalty.programme')
  @Idempotent()
  tierRate(@Param('code') code: string, @Body(new ZodPipe(TierRate)) b: Body<typeof TierRate>) {
    return this.programme.setTierRate(code, b);
  }

  @Get('cashback/preview')
  @RequirePermission('loyalty.finance')
  preview(@Query('month') month = new Date().toISOString().slice(0, 7)) {
    return this.cashback.preview(month);
  }

  @Get('cashback/batches')
  @RequirePermission('loyalty.finance')
  batches() {
    return this.cashback.list();
  }

  @Get('cashback/batches/:batchId')
  @RequirePermission('loyalty.finance')
  batch(@Param('batchId', ParseUUIDPipe) id: string) {
    return this.cashback.get(id);
  }

  @Post('cashback/batches')
  @RequirePermission('loyalty.finance')
  @Idempotent()
  generate(@Body(new ZodPipe(Generate)) b: Body<typeof Generate>) {
    return this.cashback.generate(b.month, b.note ?? null);
  }

  @Post('cashback/batches/:batchId/approve')
  @HttpCode(200)
  @RequirePermission('loyalty.finance')
  @Idempotent()
  approve(@Param('batchId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Approve)) b: Body<typeof Approve>) {
    return this.cashback.approve(id, b);
  }

  @Post('cashback/batches/:batchId/post')
  @HttpCode(200)
  @RequirePermission('loyalty.finance')
  @Idempotent()
  post(@Param('batchId', ParseUUIDPipe) id: string) {
    return this.cashback.post(id);
  }

  @Post('cashback/batches/:batchId/discard')
  @HttpCode(200)
  @RequirePermission('loyalty.finance')
  @Idempotent()
  discard(@Param('batchId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Discard)) b: Body<typeof Discard>) {
    return this.cashback.discard(id, b.reason);
  }

  @Get('reports/movement')
  @RequirePermission('loyalty.report')
  movement(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.movement(from, to);
  }

  @Get('reports/liability')
  @RequirePermission('loyalty.report')
  liability() {
    return this.reports.liability();
  }

  @Get('reports/activity')
  @RequirePermission('loyalty.report')
  activity(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.activity(from, to);
  }

  @Get('reports/pending')
  @RequirePermission('loyalty.report')
  pending() {
    return this.reports.pending();
  }

  @Get('reports/exceptions')
  @RequirePermission('loyalty.report')
  exceptions(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.exceptions(from, to);
  }

  /** The member's own page from the link on their card or receipt (LOY23). No sign-in; the token is the secret. */
  @Get('m/:token')
  @Public()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex')
  async self(@Param('token') token: string) {
    return renderSelfService(await this.members.selfService(token));
  }
}
