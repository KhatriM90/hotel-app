import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** scrypt$N$r$p$salt$hash (base64). No native build needed on ARM64. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('Password must be at least 10 characters');
  return hashSecret(password);
}

async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Why a POS PIN is refused, or null if it is acceptable: 4 to 6 digits, not
 * one repeated digit and not a run such as 1234 or 9876.
 */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'A PIN is 4 to 6 digits';
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return 'Do not use the same digit throughout';
  const steps = d.slice(1).map((x, i) => x - d[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Do not use a run of digits such as 1234';
  return null;
}

/** Hashes a POS PIN with scrypt like a password; verify it with verifyPassword. */
export async function hashPin(pin: string): Promise<string> {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  return hashSecret(pin);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
