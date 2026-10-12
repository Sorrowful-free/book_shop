import { describe, expect, it } from "bun:test";
import { hashPassword, isPasswordValid, verifyPassword } from "./password";

describe("hashPassword / verifyPassword (argon2id)", () => {
  it("hashes a password and verifies it back", async () => {
    const hash = await hashPassword("Str0ng!pass");

    // never stored/returned in plain text
    expect(hash).not.toContain("Str0ng!pass");
    // argon2 encoded form
    expect(hash.startsWith("$argon2")).toBe(true);

    expect(await verifyPassword(hash, "Str0ng!pass")).toBe(true);
  });

  it("produces a salted hash (same input, different hashes)", async () => {
    const a = await hashPassword("Str0ng!pass");
    const b = await hashPassword("Str0ng!pass");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "Str0ng!pass")).toBe(true);
    expect(await verifyPassword(b, "Str0ng!pass")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("Str0ng!pass");
    expect(await verifyPassword(hash, "Str0ng!pass2")).toBe(false);
    expect(await verifyPassword(hash, "")).toBe(false);
  });
});

describe("isPasswordValid — min 8 chars, letter + digit + special", () => {
  it.each(["abcd1234!", "A1!bcdefgh", "p@ssw0rdXYZ", "8char$ok"])(
    "accepts %j",
    (password) => {
      expect(isPasswordValid(password)).toBe(true);
    }
  );

  it.each([
    ["aB1!", "too short"],
    ["abcdefgh!", "no digit"],
    ["12345678!", "no letter"],
    ["abcd1234", "no special character"],
    ["", "empty"],
    ["abcdefg", "short + no digit + no special"]
  ])("rejects %j (%s)", (password) => {
    expect(isPasswordValid(password)).toBe(false);
  });
});
