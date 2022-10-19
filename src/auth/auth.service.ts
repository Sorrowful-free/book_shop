import { Injectable, NotFoundException } from "@nestjs/common";
import { AuthTokensDto } from "../dto/auth-tokens.dto";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
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

  async login(username: string, password: string): Promise<AuthTokensDto> {
    const user = await this.databaseService.findUserByUserName(
      username,
      password
    );
    if (!user || user.password !== password) {
      throw new NotFoundException(`user with name :${username} not found`);
    }
    return this.getAuthTokens(user);
  }

  async refresh(userId: number): Promise<AuthTokensDto> {
    const user = await this.databaseService.findUserById(userId);
    if (!user) {
      throw new NotFoundException(`user with user id :${userId} not found`);
    }
    return this.getAuthTokens(user);
  }

  private getAuthTokens(user: UserDto): AuthTokensDto {
    const accessToken = this.jwtService.sign(
      this.getAccessTokenPayLoad(user),
      this.getJwtSignOptions(this.jwtConfig.accessTokenExpiresIn)
    );

    const refreshToken = this.jwtService.sign(
      this.getRefreshTokenPayLoad(user),
      this.getJwtSignOptions(this.jwtConfig.refreshTokenExpiresIn)
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_in: this.jwtConfig.accessTokenExpiresIn,
      refresh_token_expires_in: this.jwtConfig.refreshTokenExpiresIn
    };
  }

  private getAccessTokenPayLoad(user: UserDto): JwtTokenPayloadDto {
    return {
      userid: user.userid,
      username: user.username,
      password: user.password
    };
  }

  private getRefreshTokenPayLoad(user: UserDto): JwtTokenPayloadDto {
    return {
      userid: user.userid
    };
  }

  private getJwtSignOptions(expiresIn: number): JwtSignOptions {
    return {
      secret: this.jwtConfig.secret,
      expiresIn: expiresIn
    };
  }
}
