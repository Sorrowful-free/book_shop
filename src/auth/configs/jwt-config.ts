import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const JWT_ACCESS_TOKEN_EXPIRES_IN_ENV_KEY =
  "JWT_ACCESS_TOKEN_EXPIRES_IN";
export const JWT_REFRESH_TOKEN_EXPIRES_IN_ENV_KEY =
  "JWT_REFRESH_TOKEN_EXPIRES_IN";
export const JWT_TOKEN_SECRET_ENV_KEY = "JWT_TOKEN_SECRET";

@Injectable()
export class JwtConfig {
  readonly accessTokenExpiresIn: number;
  readonly refreshTokenExpiresIn: number;
  readonly tokenSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.accessTokenExpiresIn = this.configService.get<number>(
      JWT_ACCESS_TOKEN_EXPIRES_IN_ENV_KEY
    );
    this.refreshTokenExpiresIn = this.configService.get<number>(
      JWT_REFRESH_TOKEN_EXPIRES_IN_ENV_KEY
    );
    this.tokenSecret = this.configService.get<string>(JWT_TOKEN_SECRET_ENV_KEY);
  }
}
