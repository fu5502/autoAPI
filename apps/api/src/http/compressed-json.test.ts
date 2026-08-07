import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerCompressedJsonParser } from "./compressed-json.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("compressed JSON parser", () => {
  it("accepts an empty JSON body for requests such as DELETE", async () => {
    const app = Fastify({ logger: false });
    registerCompressedJsonParser(app);
    app.delete("/sites/:id", async (request) => ({
      id: (request.params as { id: string }).id,
      body: request.body,
    }));
    apps.push(app);

    const response = await app.inject({
      method: "DELETE",
      url: "/sites/42",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "42" });
  });
});
