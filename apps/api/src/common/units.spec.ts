import { hashPassword, verifyPassword } from '../auth/password';
import { canonicalJson } from '../idempotency/idempotency';
import { backoffSeconds } from '../integration/outbox.service';
import { loadConfig } from '../config';

describe('canonicalJson', () => {
  it('ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: '1.00' })).not.toBe(canonicalJson({ a: '1.0' }));
  });
});

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse battery', hash)).resolves.toBe(false);
    await expect(verifyPassword('anything', 'garbage')).resolves.toBe(false);
  });

  it('rejects short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });
});

describe('outbox backoff', () => {
  it('grows exponentially and caps at one hour', () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(5)).toBe(480);
    expect(backoffSeconds(30)).toBe(3600);
  });
});

describe('config', () => {
  it('refuses weak secrets', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://a@b/c', JWT_SECRET: 'short', WORKER_TOKEN: 'x'.repeat(40) } as NodeJS.ProcessEnv),
    ).toThrow(/JWT_SECRET/);
  });
});
