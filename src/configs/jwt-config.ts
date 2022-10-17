import { Injectable } from "@nestjs/common";

@Injectable()
export class JwtConfig {
  accessTokenExpiresInHours = 8;
  refreshTokenExpiresInHours = 30;
  secret = "super_puper_secret";
}
