import { Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { FoliosService } from './folios.service';
import { FrontDeskService } from './frontdesk.service';
import { FoliosController, FrontDeskController, GuestsController, ReservationsController, RoomsController } from './frontoffice.controller';
import { GuestsService } from './guests.service';
import { RatesService } from './rates.service';
import { ReservationsService } from './reservations.service';
import { RoomsService } from './rooms.service';

/** Reservations, front desk and the basic folio (RES-01 … RES-08, FD-01 … FD-08, BIL-01, BIL-06, BIL-09). */
@Module({
  controllers: [RoomsController, ReservationsController, FrontDeskController, FoliosController, GuestsController],
  providers: [ApprovalsService, RoomsService, RatesService, GuestsService, FoliosService, ReservationsService, FrontDeskService],
  exports: [RoomsService, FoliosService, ApprovalsService],
})
export class FrontOfficeModule {}
