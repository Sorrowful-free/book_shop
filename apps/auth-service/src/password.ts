import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing/validation.
 * Spec §11: argon2id via @node-rs/argon2 (runtime-portable — no Bun.password).
 */

/** Hash a plaintext password with argon2id. Never returns plaintext. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Constant-time check of a plaintext password against an argon2 hash. */
export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await verify(hash, password);
  } catch {
    // malformed hash — treat as a failed check, never throw into the login path
    return false;
  }
}

/**
 * Constant pre-computed argon2id hash verified on the "unknown user" login
 * path — the miss still pays a full argon2 verify so response time doesn't
 * leak account existence. Computed once per process with the same
 * parameters as real password hashes.
 */
let dummyHashPromise: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hash("dummy-password-not-a-real-secret");
  return dummyHashPromise;
}

/**
 * Policy check (spec §11): min 8 chars, at least one letter, one digit and
 * one special character.
 */
export function isPasswordValid(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}
