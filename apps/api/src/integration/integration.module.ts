import { Module } from '@nestjs/common';
import { SapIntegrationController, WorkerController } from './integration.controller';
import { OutboxService } from './outbox.service';

@Module({
  controllers: [WorkerController, SapIntegrationController],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class IntegrationModule {}
