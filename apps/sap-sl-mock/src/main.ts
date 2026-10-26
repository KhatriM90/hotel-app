import { createMockServiceLayer } from './server';

const port = Number(process.env.PORT ?? 50000);
const { server } = createMockServiceLayer({
  companyDb: process.env.SL_COMPANY_DB ?? 'HOTEL_TEST',
  username: process.env.SL_USERNAME ?? 'manager',
  password: process.env.SL_PASSWORD ?? 'manager',
});
server.listen(port, '0.0.0.0', () => {
  console.log(`SAP Service Layer mock listening on :${port} (/b1s/v2, control at /mock/*)`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
