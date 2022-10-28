import { Injectable } from "@nestjs/common";
import { InjectRedis } from "@liaoliaots/nestjs-redis";
import Redis from "ioredis";

export const REDIS_ORDER_NAMESPACE = "REDIS_ORDER_NAMESPACE";

@Injectable()
export class TempDatabaseService {
  constructor(
    @InjectRedis(/*REDIS_ORDER_NAMESPACE*/) private readonly redis: Redis
  ) {}
}
