// Password hashing with node:crypto scrypt — zero native dependencies
// (spec: docs/superpowers/specs/2026-07-21-real-login-design.md).
//
// Stored format: scrypt:N:r:p:<salt-hex>:<hash-hex>, N=16384 r=8 p=1, 64-byte
// key. Rows not matching this format are legacy plain-text (the pre-auth
// demo seed); a successful plain-text verify lets the caller lazily re-hash
// and save, upgrading the row in place.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** True when the stored value predates hashing (plain-text compare applies). */
export function isLegacyPlaintext(stored: string): boolean {
  return !stored.startsWith("scrypt:");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isLegacyPlaintext(stored)) return stored === password;
  const parts = stored.split(":");
  if (parts.length !== 6) return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
