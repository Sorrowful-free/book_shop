import { Injectable } from "@nestjs/common";
import { SuccessLoginDto } from "../dto/success-login.dto";
import { JwtService } from "@nestjs/jwt";
import { JwtConfig } from "../configs/jwt-config";
import { DatabaseService } from "../database/database.service";
import { JwtTokenPayloadDto } from "../dto/jwt-token-payload-dto";
import { UserDto } from "../dto/user-dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtConfig: JwtConfig,
    private readonly jwtService: JwtService,
    private readonly databaseService: DatabaseService
  ) {}

  login(userName: string, pass: string): SuccessLoginDto {
    const user = this.databaseService.findUserByUserName(userName, pass);

    const accessToken = this.jwtService.sign(this.getAccessTokenPayLoad(user), {
      secret: this.jwtConfig.secret
    });

    const refreshToken = this.jwtService.sign(
      this.getRefreshTokenPayLoad(user),
      { secret: this.jwtConfig.secret }
    );
    return {
      access_token: accessToken,
      access_token_expires_in: this.jwtConfig.accessTokenExpiresInHours,
      refresh_token: refreshToken,
      refresh_token_expires_in: this.jwtConfig.refreshTokenExpiresInHours
    };
  }

  private getAccessTokenPayLoad(user: UserDto): JwtTokenPayloadDto {
    return {
      user_id: user.user_id,
      user_name: user.user_name,
      pass: user.pass,
      expires_in: this.getExpirationDate(
        this.jwtConfig.accessTokenExpiresInHours
      )
    };
  }

  private getRefreshTokenPayLoad(user: UserDto): JwtTokenPayloadDto {
    return {
      user_id: user.user_id,
      expires_in: this.getExpirationDate(
        this.jwtConfig.refreshTokenExpiresInHours
      )
    };
  }

  private getExpirationDate(expiresInHours: number): Date {
    const expirationDate = new Date(Date.now());
    expirationDate.setHours(expirationDate.getHours() + expiresInHours);
    return expirationDate;
  }
}
