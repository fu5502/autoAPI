import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const VERSION = "scrypt-v1";
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `${VERSION}.${salt.toString("base64url")}.${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [version, saltValue, hashValue] = encoded.split(".");
  if (version !== VERSION || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
