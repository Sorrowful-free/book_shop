import { Injectable, NotFoundException } from "@nestjs/common";
import { AuthTokensDto } from "../dto/auth-tokens.dto";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import { JwtConfig } from "../configs/jwt-config";
import { DatabaseService } from "../database/database.service";
import { JwtAccessTokenPayloadDto } from "../dto/jwt-access-token-payload-dto";
import { UserDto } from "../dto/user-dto";
import { JwtRefreshTokenPayloadDto } from "../dto/jwt-refresh-token-payload-dto";

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

  private getAccessTokenPayLoad(user: UserDto): JwtAccessTokenPayloadDto {
    return {
      user_id: user.user_id,
      user_name: user.user_name,
      user_role: user.user_role
    };
  }

  private getRefreshTokenPayLoad(user: UserDto): JwtRefreshTokenPayloadDto {
    return {
      user_id: user.user_id
    };
  }

  private getJwtSignOptions(expiresIn: number): JwtSignOptions {
    return {
      secret: this.jwtConfig.secret,
      expiresIn: expiresIn
    };
  }
}
