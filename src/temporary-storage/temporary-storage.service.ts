import { Injectable } from "@nestjs/common";
import { InjectRedis } from "@liaoliaots/nestjs-redis";
import Redis from "ioredis";
import { OrderDto } from "../dto/order-dto";
import { RedisConfig } from "./configs/redis-config";

export const REDIS_ORDER_NAMESPACE = "REDIS_ORDER_NAMESPACE";

@Injectable()
export class TemporaryStorageService {
  constructor(
    @InjectRedis(/*REDIS_ORDER_NAMESPACE*/) private readonly redis: Redis,
    private readonly redisConfig: RedisConfig
  ) {}

  async storeOrder(orderDto: OrderDto): Promise<OrderDto> {
    await this.redis.setex(
      orderDto.order_id,
      this.redisConfig.expireIn,
      JSON.stringify(orderDto)
    );
    return orderDto;
  }

  async findOrder(orderId: any): Promise<OrderDto> {
    const valueString = await this.redis.get(orderId);
    if (!valueString) {
      return undefined;
    }
    return JSON.parse(valueString);
  }

  async deleteOrder(orderId: any): Promise<void> {
    await this.redis.del(orderId);
  }
}
