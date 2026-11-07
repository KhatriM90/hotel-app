import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { hasPermission } from '@hotel/shared';
import { z } from 'zod';
import { BridgeOnly, CurrentProperty, PropertyScoped, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { requestContext } from '../db/request-context';
import { CurrentPropertyT } from '../frontoffice/common';
import { Idempotent } from '../idempotency/idempotency';
import { DoorLocksService } from './doorlocks.service';

const Code = z.string().trim().regex(/^[0-9A-Za-z]{1,32}$/, 'letters and digits from the lock supplier');
const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    systemCode: Code.nullable(),
    hotelCode: Code.nullable(),
    cardPass: z.string().trim().toUpperCase().regex(/^[0-9A-F]{12}$/, '12 hex characters, default 82A094FFFFFF'),
    comPort: z.number().int().min(1).max(64),
    cardGraceMinutes: z.number().int().min(0).max(720),
    nextCardNo: z.number().int().min(1).max(16777215),
  })
  .partial()
  .strict();
const RoomAddressesSchema = z.object({
  rooms: z
    .array(z.object({ number: z.string().trim().min(1).max(10), lockAddress: z.string().trim().regex(/^01\d{9}$/, '11 digits starting 01').nullable() }))
    .min(1)
    .max(500),
});
const IssueSchema = z.object({ kind: z.enum(['new', 'duplicate']), count: z.number().int().min(1).max(6).default(1) });
const BridgeHello = z.object({
  bridgeId: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  version: z.string().max(40),
  mode: z.enum(['dll', 'mock']),
});
const BridgeResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    bridgeId: z.string().min(3),
    outcome: z.literal('done'),
    cardNo: z.number().int().min(0).max(16777215).nullish(),
    systemCode: z.string().max(64).nullish(),
  }),
  z.object({
    bridgeId: z.string().min(3),
    outcome: z.literal('failed'),
    errorCode: z.number().int().nullish(),
    error: z.string().min(1).max(2000),
  }),
]);
type B<T extends z.ZodTypeAny> = z.infer<T>;

/** Door lock set-up per property (INT-09): supplier codes, encoder PC pairing and room lock addresses. */
@Controller('properties/:propertyCode/door-locks')
@PropertyScoped()
export class DoorLockSettingsController {
  constructor(private readonly locks: DoorLocksService) {}

  @Get('settings')
  @RequirePermission('keycard.issue')
  settings(@CurrentProperty() p: CurrentPropertyT) {
    // Reception sees whether cards work; only managers see the supplier codes.
    const user = requestContext.get()?.user;
    return this.locks.settings(p.id, !!user && hasPermission(user.roles, 'doorlock.configure'));
  }

  @Put('settings')
  @RequirePermission('doorlock.configure')
  update(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(SettingsSchema)) b: B<typeof SettingsSchema>) {
    return this.locks.updateSettings(p.id, b);
  }

  @Post('bridge/pair')
  @HttpCode(200)
  @RequirePermission('doorlock.configure')
  pair(@CurrentProperty() p: CurrentPropertyT) {
    return this.locks.pairBridge(p.id);
  }

  @Post('bridge/unpair')
  @HttpCode(200)
  @RequirePermission('doorlock.configure')
  unpair(@CurrentProperty() p: CurrentPropertyT) {
    return this.locks.unpairBridge(p.id);
  }

  @Get('rooms')
  @RequirePermission('doorlock.configure')
  rooms(@CurrentProperty() p: CurrentPropertyT) {
    return this.locks.rooms(p.id);
  }

  @Put('rooms')
  @RequirePermission('doorlock.configure')
  setRooms(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(RoomAddressesSchema)) b: B<typeof RoomAddressesSchema>) {
    return this.locks.setRoomAddresses(p.id, b.rooms);
  }

  @Post('read-card')
  @HttpCode(200)
  @RequirePermission('keycard.issue')
  read(@CurrentProperty() p: CurrentPropertyT) {
    return this.locks.requestRead(p.id);
  }

  @Get('jobs/:id')
  @RequirePermission('keycard.issue')
  job(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string) {
    return this.locks.job(p.id, id);
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  @RequirePermission('keycard.issue')
  cancel(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string) {
    return this.locks.cancel(p.id, id);
  }
}

/** Guest key cards on a stay (FD-03 check-in, FD-05 keys history through room moves). */
@Controller('properties/:propertyCode/stays/:stayId/key-cards')
@PropertyScoped()
export class StayKeyCardsController {
  constructor(private readonly locks: DoorLocksService) {}

  @Get()
  @RequirePermission('reservation.read')
  list(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string) {
    return this.locks.forStay(p.id, stayId);
  }

  @Post()
  @RequirePermission('keycard.issue')
  @Idempotent()
  issue(@CurrentProperty() p: CurrentPropertyT, @Param('stayId', ParseUUIDPipe) stayId: string, @Body(new ZodPipe(IssueSchema)) b: B<typeof IssueSchema>) {
    return this.locks.issue(p.id, stayId, b);
  }
}

/** Pull API for the bridge on the reception encoder PC (outbound HTTPS only, like the SAP worker). */
@Controller('door-locks/bridge')
@BridgeOnly()
export class DoorLockBridgeController {
  constructor(private readonly locks: DoorLocksService) {}

  @Post('claim')
  @HttpCode(200)
  claim(@CurrentProperty() p: CurrentPropertyT, @Body(new ZodPipe(BridgeHello)) b: B<typeof BridgeHello>) {
    return this.locks.claim(p.id, b).then((r) => ({ property: p.code, ...r }));
  }

  @Post('jobs/:id/result')
  @HttpCode(200)
  result(@CurrentProperty() p: CurrentPropertyT, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(BridgeResultSchema)) b: B<typeof BridgeResultSchema>) {
    const { bridgeId, ...result } = b;
    return this.locks.complete(p.id, id, bridgeId, result);
  }
}
