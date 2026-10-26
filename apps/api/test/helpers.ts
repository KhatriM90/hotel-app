import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';

export async function startApp(): Promise<INestApplication> {
  const app = await createApp(loadConfig());
  await app.init();
  return app;
}

export async function login(app: INestApplication, username: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ username, password: process.env.SEED_PASSWORD })
    .expect(200);
  return res.body.accessToken as string;
}

/** Owner connection (bypasses nothing by itself: still sets all_properties for RLS-protected tables). */
export async function ownerClient(): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
  await c.connect();
  await c.query(`SET app.all_properties = 'on'`);
  return c;
}

/** Runtime-role connection with no scope set, as the API would be before auth. */
export async function appClient(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
}

export function uniqueKey(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
