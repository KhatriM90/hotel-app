import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { AppExceptionFilter } from './common/pg-exception.filter';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { APP_CONFIG, AppConfig } from './config';
import { DbModule } from './db/db.module';
import { FrontOfficeModule } from './frontoffice/frontoffice.module';
import { HealthModule } from './health/health.controller';
import { IdempotencyInterceptor } from './idempotency/idempotency';
import { IntegrationModule } from './integration/integration.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { NumberingModule } from './numbering/numbering.service';
import { PosModule } from './pos/pos.module';
import { PropertiesModule } from './properties/properties.module';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    const queues = config.QUEUES_ENABLED && config.REDIS_URL ? [MaintenanceModule.register(config.REDIS_URL)] : [];
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DbModule,
        AuditModule,
        NumberingModule,
        AuthModule,
        HealthModule,
        PropertiesModule,
        IntegrationModule,
        FrontOfficeModule,
        PosModule,
        LoyaltyModule,
        ...queues,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
