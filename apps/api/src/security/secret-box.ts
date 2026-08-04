import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface SecretBox {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  mask(plaintext: string): string;
}

export function createSecretBox(secret: string): SecretBox {
  const key = deriveKey(secret);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return ["v1", iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
    },
    decrypt(ciphertext) {
      const [version, ivValue, tagValue, encryptedValue] = ciphertext.split(".");
      if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
        throw new Error("Unsupported credential ciphertext");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
    mask(plaintext) {
      const suffix = plaintext.slice(-4);
      return `${"*".repeat(Math.max(8, Math.min(20, plaintext.length - 4)))}${suffix}`;
    },
  };
}

function deriveKey(secret: string): Buffer {
  try {
    const decoded = Buffer.from(secret, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to a deterministic development-friendly key derivation.
  }
  return createHash("sha256").update(secret).digest();
}
