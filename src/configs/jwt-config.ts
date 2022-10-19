import { Injectable } from "@nestjs/common";

@Injectable()
export class JwtConfig {
  accessTokenExpiresIn = 8 * 60 * 60;
  refreshTokenExpiresIn = 30 * 60 * 60;
  secret = "super_puper_secret";
}
