import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { JwtService } from "@nestjs/jwt";
import { JwtConfig } from "../../configs/jwt-config";
import { JwtAccessTokenPayloadDto } from "../../dto/jwt-access-token-payload-dto";
import { UserDto } from "../../dto/user-dto";

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

  async validate(tokenPayload: any): Promise<JwtAccessTokenPayloadDto> {
    return Promise.resolve(<UserDto>tokenPayload);
  }
}
