import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import type { MemoryStore } from "../db/memory-store.js";
import type { Channel, Protocol } from "../domain/types.js";
import type { SecretBox } from "../security/secret-box.js";

export async function startMockUpstream(
  configure: (app: FastifyInstance) => void,
): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const app = Fastify({ logger: false });
  configure(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function addHealthyChannel(
  store: MemoryStore,
  secrets: SecretBox,
  input: {
    name: string;
    baseUrl: string;
    protocol?: Protocol;
    model?: string;
    priority?: number;
    weight?: number;
    balance?: number | null;
    minBalance?: number;
  },
): Promise<Channel> {
  const apiKey = `sk-test-${input.name}`;
  const model = input.model ?? "test-model";
  const imported = await store.importProvider(
    {
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey,
      protocol: input.protocol ?? "openai",
      models: [model],
      priority: input.priority ?? 10,
      weight: input.weight ?? 100,
      minBalance: input.minBalance,
      tags: [],
    },
    secrets.encrypt(apiKey),
    apiKey.slice(-4),
  );
  await store.applyProbeResult(
    imported.channel.id,
    {
      ok: true,
      protocol: input.protocol ?? "openai",
      models: [model],
      latencyMs: 50,
      chatOk: true,
      streamOk: true,
      balance: input.balance ?? 10,
      balanceCurrency: "USD",
      balanceStatus: "ok",
      error: null,
    },
    3,
  );
  return (await store.getChannel(imported.channel.id))!;
}

export async function readBody(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<string> {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  const parts: Uint8Array[] = [];
  for await (const chunk of body) parts.push(chunk);
  const length = parts.reduce((total, part) => total + part.length, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(merged);
}
