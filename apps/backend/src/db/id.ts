import { randomBytes } from "node:crypto";

/**
 * RFC 9562 UUID v7 (48-bit ms timestamp + random bits). Used for every
 * text primary key in the schema — Node's crypto.randomUUID() is v4-only
 * and the database (Postgres 16) has no built-in uuidv7().
 */
export function newId(): string {
  const b = randomBytes(16);
  const ms = Date.now();
  b[0] = (ms / 2 ** 40) & 0xff;
  b[1] = (ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
