import { InjectQueue, Processor, WorkerHost, BullModule } from '@nestjs/bullmq';
import { DynamicModule, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { IntegrationModule } from '../integration/integration.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { MaintenanceService } from './maintenance.service';

export const MAINTENANCE_QUEUE = 'maintenance';

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(private readonly maintenance: MaintenanceService) {
    super();
  }

  async process() {
    const result = await this.maintenance.tick();
    if (Object.values(result).some(Boolean)) this.logger.log(JSON.stringify(result));
    return result;
  }
}

@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler('maintenance-tick', { every: 60_000 }, { name: 'tick' });
  }
}

/**
 * BullMQ-driven background housekeeping. Night audit (BIL-10), flash reports
 * (RPT-07) and failed-job alerts (OPS-01) will be added as further queues here.
 */
@Module({})
export class MaintenanceModule {
  static register(redisUrl: string): DynamicModule {
    const url = new URL(redisUrl);
    return {
      module: MaintenanceModule,
      imports: [
        BullModule.forRoot({
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            password: url.password ? decodeURIComponent(url.password) : undefined,
            username: url.username ? decodeURIComponent(url.username) : undefined,
            db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
            tls: url.protocol === 'rediss:' ? {} : undefined,
          },
          prefix: 'hotel',
        }),
        BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
        IntegrationModule,
        LoyaltyModule,
      ],
      providers: [MaintenanceService, MaintenanceProcessor, MaintenanceScheduler],
    };
  }
}
