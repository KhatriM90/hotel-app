import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppConfig } from './config';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger: config.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
  });
  app.setGlobalPrefix('api');
  app.set('trust proxy', 'loopback, uniquelocal'); // behind Caddy
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  if (config.CORS_ORIGINS) {
    app.enableCors({ origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false });
  }
  app.enableShutdownHooks();
  return app;
}
