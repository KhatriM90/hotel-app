import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@hotel/sap-sl-mock': resolve(__dirname, '../sap-sl-mock/src/server.ts') } },
});
