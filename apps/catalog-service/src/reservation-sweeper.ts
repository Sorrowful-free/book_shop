// Periodic sweeper for expired reservations (spec §3): marks ACTIVE rows
// whose expires_at has passed as EXPIRED. Availability is already computed
// lazily via expires_at, so this is housekeeping, not correctness — the
// interval is env-configurable (RESERVATION_SWEEP_INTERVAL_SEC, default 60).

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit
} from "@nestjs/common";
import type { PrismaClient } from "./generated/prisma";

export interface ReservationSweeperDeps {
  prisma: Pick<PrismaClient, "reservation">;
  /** Sweep interval in seconds. */
  intervalSec: number;
}

@Injectable()
export class ReservationSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: ReservationSweeperDeps) {}

  onModuleInit(): void {
    const intervalMs = Math.max(1, this.deps.intervalSec) * 1000;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.error("reservation sweep failed", error)
      );
    }, intervalMs);
    // Never hold the process (or a test run) open for the sweeper.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Marks expired ACTIVE reservations EXPIRED; returns the affected count. */
  async sweep(): Promise<number> {
    const result = await this.deps.prisma.reservation.updateMany({
      where: { status: "ACTIVE", expiresAt: { lte: new Date() } },
      data: { status: "EXPIRED" }
    });
    return result.count;
  }
}
