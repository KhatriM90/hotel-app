import { Module } from '@nestjs/common';
import { FrontOfficeModule } from '../frontoffice/frontoffice.module';
import { IntegrationModule } from '../integration/integration.module';
import { PosChecksService } from './checks.service';
import { PosDaysService } from './days.service';
import { PosMenuService } from './menu.service';
import { PosAdminController, PosCashController, PosController, PosMenuController, PosStationsController } from './pos.controller';
import { PosReportsService } from './reports.service';
import { PosSettingsService } from './settings.service';
import { PosSettlementService } from './settlement.service';
import { PosShiftsService } from './shifts.service';

/** Point of sale for bars, restaurants and kitchens (POS-01 … POS-19, POS day close). */
@Module({
  imports: [FrontOfficeModule, IntegrationModule],
  controllers: [PosController, PosStationsController, PosCashController, PosAdminController, PosMenuController],
  providers: [PosReportsService, PosDaysService, PosMenuService, PosChecksService, PosSettlementService, PosShiftsService, PosSettingsService],
})
export class PosModule {}
