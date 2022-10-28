import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { DatabaseModule } from "../database/database.module";
import { LocalPassportStrategy } from "./passport-strategy/local-passport.strategy";
import { JwtPassportStrategy } from "./passport-strategy/jwt-passport.strategy";
import { LocalAuthGuard } from "./auth-guards/local-auth-guard";
import { PassportModule } from "@nestjs/passport";
import { JwtAuthGuard } from "./auth-guards/jwt-auth-guard";
import { JwtConfig } from "./configs/jwt-config";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [JwtModule, DatabaseModule, PassportModule, ConfigModule],
  providers: [
    AuthService,
    LocalPassportStrategy,
    JwtPassportStrategy,
    LocalAuthGuard,
    JwtAuthGuard,
    JwtConfig
  ],
  exports: [
    AuthService,
    LocalPassportStrategy,
    JwtPassportStrategy,
    LocalAuthGuard,
    JwtAuthGuard
  ],
  controllers: [AuthController]
})
export class AuthModule {}
