import { Module } from '@nestjs/common';
import { DoorLockBridgeController, DoorLockSettingsController, StayKeyCardsController } from './doorlocks.controller';
import { DoorLocksService } from './doorlocks.service';

/** Door locks (INT-09): TEMIC20 guest key cards through a bridge on each reception's encoder PC. */
@Module({
  controllers: [DoorLockSettingsController, StayKeyCardsController, DoorLockBridgeController],
  providers: [DoorLocksService],
})
export class DoorLocksModule {}
