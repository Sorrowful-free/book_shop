// Periodic GC for the refresh_tokens table (fixes spec F-A1): rows whose
// expires_at is older than REFRESH_TOKEN_AUDIT_TTL_SEC are deleted — a
// revoked or long-expired jti can neither be accepted nor reused, only the
// short audit tail matters. Live tokens and recently-expired rows are
// never touched, so rotation/revoke semantics are unchanged. Errors are
// logged and never crash the process (mirrors ReservationSweeper).

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit
} from "@nestjs/common";
import type { AuthRepository } from "./repository";

export interface RefreshTokenSweeperDeps {
  repository: Pick<AuthRepository, "deleteExpiredRefreshTokens">;
  /** Audit retention in seconds — how long expired rows are kept. */
  retentionSec: number;
  /** Sweep interval in seconds. */
  intervalSec: number;
}

@Injectable()
export class RefreshTokenSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefreshTokenSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: RefreshTokenSweeperDeps) {}

  onModuleInit(): void {
    const intervalMs = Math.max(1, this.deps.intervalSec) * 1000;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.error("refresh token sweep failed", error)
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

  /** Deletes rows expired longer than the retention ago; returns count. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - this.deps.retentionSec * 1000);
    return this.deps.repository.deleteExpiredRefreshTokens(cutoff);
  }
}
