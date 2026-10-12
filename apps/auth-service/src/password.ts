/**
 * Password hashing/validation — TYPE DECLARATIONS ONLY.
 * Contract for the TDD phase (spec §10/§11): implementation lands later and
 * must use argon2id via @node-rs/argon2 (runtime-portable, no Bun.password).
 */

/** Hash a plaintext password with argon2id. Never returns plaintext. */
export declare function hashPassword(password: string): Promise<string>;

/** Constant-time check of a plaintext password against an argon2 hash. */
export declare function verifyPassword(
  hash: string,
  password: string
): Promise<boolean>;

/**
 * Policy check (spec §11): min 8 chars, at least one letter, one digit and
 * one special character.
 */
export declare function isPasswordValid(password: string): boolean;
