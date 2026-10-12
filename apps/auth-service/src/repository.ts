import type { UserRole } from "@book-shop/contracts";

/**
 * Persistence boundary — TYPE DECLARATIONS ONLY (TDD contract phase).
 * Spec §3/§10: DB access goes through this repository interface (over Prisma)
 * so unit tests mock the interface, not Prisma. Implemented later by a
 * Prisma-backed adapter in a single transaction where noted.
 */

/** users row. passwordHash is argon2id — plaintext never leaves the service. */
export interface UserRecord {
  id: string;
  userName: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
}

export interface NewUser {
  userName: string;
  passwordHash: string;
  role: UserRole;
}

/** refresh_tokens row; id IS the refresh JWT jti. */
export interface RefreshTokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  /** null = active; set on rotation/revoke (row kept for audit, spec §11). */
  revokedAt: Date | null;
  createdAt: Date;
}

export interface NewRefreshToken {
  id: string;
  userId: string;
  expiresAt: Date;
}

/** outbox row input; relay fills id/publishedAt (spec §4). */
export interface OutboxEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface AuthRepository {
  findUserByName(userName: string): Promise<UserRecord | null>;

  findUserById(id: string): Promise<UserRecord | null>;

  /**
   * Register: insert user + one outbox row in a SINGLE transaction
   * (spec §4). `buildEvent` derives the event from the created user so the
   * payload always matches the committed row.
   */
  createUserWithOutbox(
    user: NewUser,
    buildEvent: (created: UserRecord) => OutboxEventInput
  ): Promise<UserRecord>;

  findRefreshToken(jti: string): Promise<RefreshTokenRecord | null>;

  createRefreshToken(row: NewRefreshToken): Promise<void>;

  /**
   * Atomically mark revoked (sets revoked_at WHERE revoked_at IS NULL).
   * Returns the affected row count: 0 means the jti was already revoked or
   * is unknown — callers treat that as a replay (Refresh) or ignore it
   * (RevokeToken is idempotent).
   */
  revokeRefreshToken(jti: string, revokedAt: Date): Promise<number>;

  /**
   * GC (fixes spec F-A1): delete rows whose expires_at is strictly older
   * than `cutoff` — revoked and never-revoked alike, the only criterion is
   * the age of the expiry. Rows that are still live or expired less than
   * the audit retention ago are untouched.
   */
  deleteExpiredRefreshTokens(cutoff: Date): Promise<number>;
}
