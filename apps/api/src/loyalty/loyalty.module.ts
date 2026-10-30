import { forwardRef, Module } from '@nestjs/common';
import { FrontOfficeModule } from '../frontoffice/frontoffice.module';
import { IntegrationModule } from '../integration/integration.module';
import { CashbackService } from './cashback.service';
import { LoyaltyCheckoutService } from './checkout.service';
import { LoyaltyLedgerService } from './ledger.service';
import { LoyaltyAdminController, LoyaltyCheckController, LoyaltyMembersController } from './loyalty.controller';
import { LoyaltyMembersService } from './members.service';
import { LoyaltyProgrammeService } from './programme.service';
import { LoyaltyReportsService } from './reports.service';

/** Loyalty points and club membership (addendum v1.2: LOY01, LOY05, LOY11–LOY28, CLUB01–CLUB07; replaces ADV-02). */
@Module({
  imports: [forwardRef(() => FrontOfficeModule), IntegrationModule],
  controllers: [LoyaltyMembersController, LoyaltyCheckController, LoyaltyAdminController],
  providers: [LoyaltyProgrammeService, LoyaltyLedgerService, LoyaltyMembersService, LoyaltyCheckoutService, CashbackService, LoyaltyReportsService],
  exports: [LoyaltyCheckoutService, LoyaltyLedgerService, LoyaltyProgrammeService],
})
export class LoyaltyModule {}
