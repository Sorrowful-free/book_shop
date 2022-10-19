import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { ConfigsModule } from "../configs/configs.module";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { DatabaseModule } from "../database/database.module";
import { LocalPassportStrategy } from "./passport-strategy/local-passport.strategy";
import { JwtPassportStrategy } from "./passport-strategy/jwt-passport.strategy";
import { LocalAuthGuard } from "./auth-guards/local-auth-guard";
import { PassportModule } from "@nestjs/passport";
import { JwtAuthGuard } from "./auth-guards/jwt-auth-guard";

@Module({
  imports: [ConfigsModule, JwtModule, DatabaseModule, PassportModule],
  providers: [
    AuthService,
    LocalPassportStrategy,
    JwtPassportStrategy,
    LocalAuthGuard,
    JwtAuthGuard
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
