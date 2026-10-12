/**
 * Generates an Ed25519 key pair and prints JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
 * as base64-encoded PEM for .env (spec §7). Keys live only in env vars —
 * the public key is shared with gateway and other services for JWT
 * verification, the private key stays in auth-service.
 *
 * Usage: bun run gen-keys   (from apps/auth-service)
 */
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  extractable: true
});

const privatePem = await exportPKCS8(privateKey);
const publicPem = await exportSPKI(publicKey);

process.stdout.write(
  `JWT_PRIVATE_KEY=${Buffer.from(privatePem, "utf8").toString("base64")}\n`
);
process.stdout.write(
  `JWT_PUBLIC_KEY=${Buffer.from(publicPem, "utf8").toString("base64")}\n`
);
