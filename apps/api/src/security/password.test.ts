import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("stores a salted hash and verifies the original password", () => {
    const first = hashPassword("AutoAPI@123456");
    const second = hashPassword("AutoAPI@123456");

    expect(first).not.toBe(second);
    expect(first).not.toContain("AutoAPI@123456");
    expect(verifyPassword("AutoAPI@123456", first)).toBe(true);
    expect(verifyPassword("wrong-password", first)).toBe(false);
  });

  it("rejects malformed password hashes", () => {
    expect(verifyPassword("anything", "not-a-password-hash")).toBe(false);
  });
});
