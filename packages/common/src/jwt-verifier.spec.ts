import { describe, expect, it } from "bun:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { UserRole } from "@book-shop/contracts";
import { JwtVerifier } from "./jwt-verifier";

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const spki = await exportSPKI(publicKey);
  return {
    privateKey,
    publicKeyBase64: Buffer.from(spki, "utf8").toString("base64"),
    publicKeyPem: spki
  };
}

function sign(
  privateKey: CryptoKey,
  claims: Record<string, unknown> = {},
  ttl = "1h"
) {
  return new SignJWT({
    user_name: "vasya",
    role: UserRole.Customer,
    jti: "jti-1",
    ...claims
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(privateKey);
}

describe("JwtVerifier", () => {
  it("verifies a valid token (base64 PEM key)", async () => {
    const { privateKey, publicKeyBase64 } = await makeKeys();
    const verifier = new JwtVerifier({ publicKey: publicKeyBase64 });
    const ctx = await verifier.verify(await sign(privateKey));
    expect(ctx).toEqual({
      userId: "user-1",
      userName: "vasya",
      role: UserRole.Customer,
      jti: "jti-1"
    });
  });

  it("accepts a raw PEM key too", async () => {
    const { privateKey, publicKeyPem } = await makeKeys();
    const verifier = new JwtVerifier({ publicKey: publicKeyPem });
    expect(await verifier.verify(await sign(privateKey))).not.toBeNull();
  });

  it("rejects a token signed by a different key", async () => {
    const { publicKeyBase64 } = await makeKeys();
    const other = await generateKeyPair("EdDSA");
    const verifier = new JwtVerifier({ publicKey: publicKeyBase64 });
    expect(await verifier.verify(await sign(other.privateKey))).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { privateKey, publicKeyBase64 } = await makeKeys();
    const verifier = new JwtVerifier({ publicKey: publicKeyBase64 });
    const token = await new SignJWT({ user_name: "v", role: UserRole.Customer })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("user-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);
    expect(await verifier.verify(token)).toBeNull();
  });

  it("rejects a denylisted jti", async () => {
    const { privateKey, publicKeyBase64 } = await makeKeys();
    const verifier = new JwtVerifier({
      publicKey: publicKeyBase64,
      denylist: { isRevoked: async (jti) => jti === "jti-1" }
    });
    expect(await verifier.verify(await sign(privateKey))).toBeNull();
    expect(
      await verifier.verify(await sign(privateKey, { jti: "other" }))
    ).not.toBeNull();
  });

  it("rejects malformed input", async () => {
    const { publicKeyBase64 } = await makeKeys();
    const verifier = new JwtVerifier({ publicKey: publicKeyBase64 });
    expect(await verifier.verify("not-a-jwt")).toBeNull();
  });
});
