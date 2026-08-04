import { createHash, randomBytes } from "node:crypto";

export function hashGatewayKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateGatewayKey(): string {
  return `autoapi_${randomBytes(24).toString("base64url")}`;
}
