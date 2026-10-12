import { EVENT_TYPE_TO_TOPIC, type EventType } from "@book-shop/contracts";

export interface OutboxRow {
  id: string;
  eventType: string;
  payload: unknown;
}

export interface OutboxStore {
  fetchUnpublished(limit: number): Promise<OutboxRow[]>;
  markPublished(ids: string[]): Promise<void>;
}

export interface EventPublisher {
  publish(
    topic: string,
    message: { eventType: string; payload: unknown }
  ): Promise<void>;
}

export interface OutboxRelayOptions {
  intervalMs?: number;
  batchSize?: number;
  onError?: (error: unknown) => void;
}

export class OutboxRelay {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions = {}
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const intervalMs = this.options.intervalMs ?? 1000;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.options.onError?.(error));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const rows = await this.store.fetchUnpublished(
        this.options.batchSize ?? 100
      );
      for (const row of rows) {
        const topic = EVENT_TYPE_TO_TOPIC[row.eventType as EventType];
        if (!topic) {
          this.options.onError?.(
            new Error(
              `Unknown outbox eventType "${row.eventType}" (id ${row.id})`
            )
          );
          await this.store.markPublished([row.id]);
          continue;
        }
        await this.publisher.publish(topic, {
          eventType: row.eventType,
          payload: row.payload
        });
        await this.store.markPublished([row.id]);
      }
      return rows.length;
    } finally {
      this.running = false;
    }
  }
}
