import { describe, expect, it } from "vitest";
import { createSecretBox } from "./secret-box.js";

describe("secret box", () => {
  it("encrypts credentials with randomized authenticated ciphertext", () => {
    const box = createSecretBox("test-encryption-key");
    const first = box.encrypt("sk-live-secret-1234");
    const second = box.encrypt("sk-live-secret-1234");

    expect(first).not.toContain("sk-live");
    expect(first).not.toBe(second);
    expect(box.decrypt(first)).toBe("sk-live-secret-1234");
    expect(box.decrypt(second)).toBe("sk-live-secret-1234");
    expect(box.mask("sk-live-secret-1234")).toMatch(/^\*+1234$/);
  });

  it("rejects tampered ciphertext", () => {
    const box = createSecretBox("test-encryption-key");
    const ciphertext = box.encrypt("sk-live-secret-1234");
    const parts = ciphertext.split(".");
    const payload = parts[3]!;
    parts[3] = `${payload[0] === "A" ? "B" : "A"}${payload.slice(1)}`;
    expect(() => box.decrypt(parts.join("."))).toThrow();
  });
});
