import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const REDIS_URL_ENV_KEY = "REDIS_URL";
export const REDIS_EXPIRE_IN_KEY = "REDIS_EXPIRE_IN";

@Injectable()
export class RedisConfig {
  constructor(private readonly configService: ConfigService) {}

  get url(): string {
    return this.configService.get<string>(REDIS_URL_ENV_KEY);
  }

  get expireIn(): number {
    return this.configService.get<number>(REDIS_EXPIRE_IN_KEY);
  }
}
