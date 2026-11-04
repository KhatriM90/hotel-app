import { Module } from '@nestjs/common';
import { PosModule } from '../pos/pos.module';
import { ReportExporter } from './export';
import { FlashReportService } from './flash.service';
import { HotelReportsService } from './hotel-reports.service';
import { LedgerReportsService } from './ledger.service';
import { GroupReportsController, PropertyReportsController } from './reports.controller';

/** Hotel, POS and flash reports with Excel, PDF and CSV downloads (RPT-02 … RPT-08). */
@Module({
  imports: [PosModule],
  controllers: [PropertyReportsController, GroupReportsController],
  providers: [HotelReportsService, FlashReportService, LedgerReportsService, ReportExporter],
})
export class ReportsModule {}
