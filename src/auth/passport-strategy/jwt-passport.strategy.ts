import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { JwtService } from "@nestjs/jwt";
import { JwtConfig } from "../../configs/jwt-config";
import { JwtTokenPayloadDto } from "../../dto/jwt-token-payload-dto";

@Injectable()
export class JwtPassportStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly jwtService: JwtService,
    private readonly jwtConfig: JwtConfig
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig.secret
    });
  }

  async validate(
    tokenPayload: JwtTokenPayloadDto
  ): Promise<JwtTokenPayloadDto> {
    return Promise.resolve(tokenPayload);
  }
}
