import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const REDIS_HOST_ENV_KEY = "REDIS_HOST";
export const REDIS_PORT_ENV_KEY = "REDIS_PORT";

@Injectable()
export class RedisConfig {
  constructor(private readonly configService: ConfigService) {}

  get host(): string {
    return this.configService.get<string>(REDIS_HOST_ENV_KEY);
  }

  get port(): number {
    return this.configService.get<number>(REDIS_PORT_ENV_KEY);
  }
}
