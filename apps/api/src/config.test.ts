import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const productionEnv = {
  NODE_ENV: "production",
  APP_MODE: "production",
  DATABASE_URL: "postgres://autoapi:strong-database-password@postgres:5432/autoapi",
  ADMIN_TOKEN: "admin-token-generated-for-production",
  ADMIN_PASSWORD: "strong-admin-password",
  GATEWAY_API_KEY: "gateway-key-generated-for-production",
  CREDENTIAL_ENCRYPTION_KEY: "credential-encryption-key-generated-for-production",
} satisfies NodeJS.ProcessEnv;

describe("production configuration", () => {
  it("accepts explicitly configured production secrets", () => {
    expect(() => loadConfig(productionEnv)).not.toThrow();
  });

  it("keeps remote noVNC authorization disabled by default", () => {
    expect(loadConfig(productionEnv).checkinEnableNoVnc).toBe(false);
    expect(loadConfig({ ...productionEnv, CHECKIN_ENABLE_NOVNC: "false" }).checkinEnableNoVnc).toBe(false);
    expect(loadConfig({ ...productionEnv, CHECKIN_ENABLE_NOVNC: "true" }).checkinEnableNoVnc).toBe(true);
  });

  it.each([
    ["ADMIN_TOKEN", "replace-with-a-long-admin-token"],
    ["ADMIN_PASSWORD", "AutoAPI@123456"],
    ["GATEWAY_API_KEY", "change-me-gateway"],
    ["CREDENTIAL_ENCRYPTION_KEY", "replace-with-a-base64-encoded-32-byte-key"],
    ["DATABASE_URL", "postgres://autoapi:autoapi@postgres:5432/autoapi"],
  ] as const)("rejects the %s placeholder in production", (name, value) => {
    expect(() => loadConfig({ ...productionEnv, [name]: value })).toThrow(
      "Production secrets must be configured before startup",
    );
  });
});
