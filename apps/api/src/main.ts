import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${config.PORT} (${config.NODE_ENV})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
