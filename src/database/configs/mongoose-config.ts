import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const MONGOOSE_URL_ENV_KEY = "MONGOOSE_URL";

@Injectable()
export class MongooseConfig {
  constructor(private readonly configService: ConfigService) {}
  get uri(): string {
    return this.configService.get(MONGOOSE_URL_ENV_KEY);
  }
}
