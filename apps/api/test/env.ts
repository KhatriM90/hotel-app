// Test configuration. Override TEST_DATABASE_ADMIN_URL to point at another server.
const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const url = new URL(admin);
url.pathname = '/hotel_api_test';
process.env.TEST_DATABASE_OWNER_URL = url.toString();
const app = new URL(url.toString());
app.username = 'hotel_app';
app.password = 'hotel_app_test_pw';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = app.toString();
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.WORKER_TOKEN = 'test-worker-token-test-worker-token-123';
process.env.QUEUES_ENABLED = 'false';
process.env.ENABLE_DEV_ENDPOINTS = 'true';
process.env.SEED_PASSWORD = 'test-password-123';
