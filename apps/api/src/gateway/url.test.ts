import { describe, expect, it } from "vitest";
import { apiUrl } from "./url.js";

describe("apiUrl", () => {
  it("keeps a single version segment when base and path share it", () => {
    expect(apiUrl("https://relay.example/v1", "/v1/models")).toBe("https://relay.example/v1/models");
    expect(apiUrl("https://relay.example/v1/", "/v1/chat/completions")).toBe("https://relay.example/v1/chat/completions");
  });

  it("appends the path when the base has no version segment", () => {
    expect(apiUrl("https://relay.example", "/v1/models")).toBe("https://relay.example/v1/models");
    expect(apiUrl("https://relay.example/api", "/v1beta/models")).toBe("https://relay.example/api/v1beta/models");
  });

  it("does not double a version when base is /v1 but the path targets /v1beta", () => {
    expect(apiUrl("https://relay.example/v1", "/v1beta/models/gemini-3-pro-preview:generateContent")).toBe(
      "https://relay.example/v1beta/models/gemini-3-pro-preview:generateContent",
    );
  });

  it("rewrites a /v1beta base to /v1 when the path targets /v1", () => {
    expect(apiUrl("https://relay.example/v1beta", "/v1/chat/completions")).toBe(
      "https://relay.example/v1/chat/completions",
    );
  });
});
