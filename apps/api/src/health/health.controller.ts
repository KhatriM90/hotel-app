import { Controller, Get, Module } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { DbService } from '../db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get()
  async health() {
    const started = Date.now();
    await this.db.pool.query('SELECT 1');
    return { status: 'ok', db: 'ok', dbLatencyMs: Date.now() - started, time: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
