import {
  PrismaClient,
  type Prisma,
  type User as PrismaUser,
  type Role as PrismaRole
} from "./generated/prisma";
import type { UserRole } from "@book-shop/contracts";
import type { OutboxRow, OutboxStore } from "@book-shop/common";
import type {
  AuthRepository,
  NewRefreshToken,
  NewUser,
  OutboxEventInput,
  RefreshTokenRecord,
  UserRecord
} from "./repository";

/**
 * Prisma-backed AuthRepository (spec §3). Unit tests mock the interface —
 * this adapter is only exercised by e2e against real auth_db.
 */
/** Prisma `Role` is a string union; `UserRole` is a string enum — values match. */
function toUserRecord(user: PrismaUser): UserRecord {
  return { ...user, role: user.role as UserRole };
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByName(userName: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { userName } });
    return user && toUserRecord(user);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user && toUserRecord(user);
  }

  /**
   * Register: insert user + one outbox row in a SINGLE transaction
   * (spec §4). `buildEvent` derives the event from the created user so the
   * payload always matches the committed row.
   */
  createUserWithOutbox(
    user: NewUser,
    buildEvent: (created: UserRecord) => OutboxEventInput
  ): Promise<UserRecord> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { ...user, role: user.role as PrismaRole }
      });
      const event = buildEvent(toUserRecord(created));
      await tx.outbox.create({
        data: {
          eventType: event.eventType,
          payload: event.payload as Prisma.InputJsonValue
        }
      });
      return toUserRecord(created);
    });
  }

  findRefreshToken(jti: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({ where: { id: jti } });
  }

  async createRefreshToken(row: NewRefreshToken): Promise<void> {
    await this.prisma.refreshToken.create({ data: row });
  }

  /**
   * Atomic conditional revoke — `revokedAt IS NULL` is part of the WHERE,
   * so two concurrent rotations of the same jti can't both win (TOCTOU):
   * exactly one updateMany affects a row, the loser sees count 0.
   */
  async revokeRefreshToken(jti: string, revokedAt: Date): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: jti, revokedAt: null },
      data: { revokedAt }
    });
    return count;
  }

  /** Deletes every row past the audit-retention cutoff; returns the count. */
  async deleteExpiredRefreshTokens(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: cutoff } }
    });
    return count;
  }
}

/**
 * OutboxStore over the prisma `outbox` table for OutboxRelay (spec §4).
 * Batch selection uses SELECT … FOR UPDATE SKIP LOCKED so concurrent relay
 * instances don't fight over the same rows (at-least-once is preserved
 * either way).
 */
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaClient) {}

  fetchUnpublished(limit: number): Promise<OutboxRow[]> {
    return this.prisma.$transaction(
      (tx) =>
        tx.$queryRaw<OutboxRow[]>`
        SELECT id, event_type AS "eventType", payload,
               created_at AS "occurredAt"
        FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `
    );
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.prisma.outbox.updateMany({
      where: { id: { in: ids }, publishedAt: null },
      data: { publishedAt: new Date() }
    });
  }
}
