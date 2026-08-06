import { describe, expect, it } from "vitest";
import type { Channel, GatewayKey } from "../domain/types.js";
import { hashGatewayKey } from "../security/gateway-key.js";
import { createSecretBox } from "../security/secret-box.js";
import { prepareState } from "./import-memory-state.js";

describe("memory state production preparation", () => {
  it("re-encrypts channel credentials and rotates the development gateway key", () => {
    const sourceKey = "change-me-in-development-only";
    const targetKey = "production-credential-key";
    const gatewayApiKey = "production-gateway-key";
    const channel = {
      id: "769c8832-8047-4f44-90fe-3ad49cc6d882",
      providerId: "cc2d2972-6dac-4502-82ac-5550ed660c95",
      providerName: "Provider",
      name: "Channel",
      baseUrl: "https://example.com",
      faviconUrl: null,
      protocol: "openai",
      keyCiphertext: createSecretBox(sourceKey).encrypt("sk-secret"),
      keyName: "API Key",
      keyLast4: "cret",
      status: "healthy",
      enabled: true,
      priority: 1,
      weight: 100,
      minBalance: null,
      balance: null,
      balanceCurrency: null,
      balanceStatus: "unknown",
      consecutiveFailures: 0,
      cooldownUntil: null,
      isolationReason: null,
      lastCheckedAt: null,
      lastLatencyMs: null,
      recentRequestCount: 0,
      recentErrorRate: 0,
      models: ["model"],
      tags: [],
      createdAt: "2026-08-06T00:00:00.000Z",
    } satisfies Channel;
    const gatewayKey = {
      id: "104698c6-475a-44dc-99ed-68995fd96b0e",
      name: "环境变量密钥",
      keyHash: hashGatewayKey("change-me-gateway"),
      keyLast4: "eway",
      enabled: true,
      createdAt: "2026-08-06T00:00:00.000Z",
      lastUsedAt: null,
    } satisfies GatewayKey;

    const result = prepareState({
      version: 1,
      channels: [channel],
      routes: [],
      usage: [{
        requestId: "c5991f8e-c155-4c39-ac6d-e83f09262f40",
        channelId: "84a730af-2c63-4e25-b5c1-f63311bf8a90",
        modelAlias: "model",
        upstreamModel: "model",
        clientName: "test",
        requestKind: "chat",
        statusCode: 200,
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 100,
        errorType: null,
        retryCount: 0,
        streamed: false,
        createdAt: "2026-08-06T00:00:00.000Z",
      }],
      gatewayKeys: [gatewayKey],
      playgroundSessions: [],
      adminAccount: undefined,
      adminLoginHistory: [],
    }, { sourceCredentialKey: sourceKey, targetCredentialKey: targetKey, gatewayApiKey });

    expect(createSecretBox(targetKey).decrypt(result.state.channels[0]!.keyCiphertext)).toBe("sk-secret");
    expect(result.state.gatewayKeys[0]).toMatchObject({
      keyHash: hashGatewayKey(gatewayApiKey),
      keyLast4: "-key",
    });
    expect(result.state.usage[0]!.channelId).toBeNull();
    expect(result.changes).toEqual({
      credentialsReencrypted: 1,
      developmentGatewayKeysRotated: 1,
      orphanedUsageChannelRefsCleared: 1,
      orphanedSessionChannelRefsCleared: 0,
    });
  });
});
