import { describe, expect, it } from "bun:test";
import { RefreshTokenSweeper } from "./refresh-token-sweeper";
import type { AuthRepository, RefreshTokenRecord } from "./repository";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-memory mirror of the prisma `expires_at < cutoff` deleteMany. */
class InMemoryRefreshTokens implements Pick<
  AuthRepository,
  "deleteExpiredRefreshTokens"
> {
  rows = new Map<string, RefreshTokenRecord>();
  calls: Date[] = [];

  add(
    jti: string,
    expiresAt: Date,
    revokedAt: Date | null = null
  ): RefreshTokenRecord {
    const row: RefreshTokenRecord = {
      id: jti,
      userId: "user-1",
      expiresAt,
      revokedAt,
      createdAt: new Date()
    };
    this.rows.set(jti, row);
    return row;
  }

  async deleteExpiredRefreshTokens(cutoff: Date): Promise<number> {
    this.calls.push(cutoff);
    let count = 0;
    for (const [jti, row] of this.rows) {
      if (row.expiresAt < cutoff) {
        this.rows.delete(jti);
        count++;
      }
    }
    return count;
  }
}

const HOUR = 3600 * 1000;

describe("RefreshTokenSweeper.sweep", () => {
  it("deletes rows expired longer than the retention ago", async () => {
    const repository = new InMemoryRefreshTokens();
    const sweeper = new RefreshTokenSweeper({
      repository,
      retentionSec: 3600, // keep a 1h audit tail
      intervalSec: 3600
    });
    const now = Date.now();
    repository.add("long-expired", new Date(now - 2 * HOUR));
    repository.add(
      "revoked-long-expired",
      new Date(now - 3 * HOUR),
      new Date()
    );
    repository.add("freshly-expired", new Date(now - 10 * 60 * 1000));
    repository.add("still-live", new Date(now + HOUR));

    const deleted = await sweeper.sweep();

    expect(deleted).toBe(2);
    expect([...repository.rows.keys()].sort()).toEqual([
      "freshly-expired",
      "still-live"
    ]);
  });

  it("deletes nothing when all rows are inside the retention window", async () => {
    const repository = new InMemoryRefreshTokens();
    const sweeper = new RefreshTokenSweeper({
      repository,
      retentionSec: 604800,
      intervalSec: 3600
    });
    const now = Date.now();
    repository.add("expired-yesterday", new Date(now - 24 * HOUR));
    repository.add("live", new Date(now + HOUR));

    expect(await sweeper.sweep()).toBe(0);
    expect(repository.rows.size).toBe(2);
  });
});

describe("RefreshTokenSweeper lifecycle", () => {
  it("runs sweep() on the interval and stops cleanly on destroy", async () => {
    const repository = new InMemoryRefreshTokens();
    const sweeper = new RefreshTokenSweeper({
      repository,
      retentionSec: 3600,
      intervalSec: 1 // minimum tick — the timer is unref'd
    });
    sweeper.onModuleInit();
    await sleep(1200);
    sweeper.onModuleDestroy();
    expect(repository.calls.length).toBeGreaterThanOrEqual(1);
    // a second destroy is a no-op
    sweeper.onModuleDestroy();
  }, 10_000);

  it("does not run again after onModuleDestroy", async () => {
    const repository = new InMemoryRefreshTokens();
    const sweeper = new RefreshTokenSweeper({
      repository,
      retentionSec: 3600,
      intervalSec: 1
    });
    sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    await sleep(1200);
    expect(repository.calls).toHaveLength(0);
  }, 10_000);
});
