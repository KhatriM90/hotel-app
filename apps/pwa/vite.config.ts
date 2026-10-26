import { defineConfig } from 'vitest/config';

// Served under /pwa/ behind Caddy so the service worker scope stays inside it.
export default defineConfig({
  base: '/pwa/',
  server: {
    port: 5174,
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' },
  },
  test: { environment: 'jsdom' },
});
