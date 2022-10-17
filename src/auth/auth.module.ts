import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { ConfigsModule } from "../configs/configs.module";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { DatabaseModule } from "../database/database.module";

@Module({
  imports: [ConfigsModule, JwtModule, DatabaseModule],
  providers: [AuthService],
  exports: [AuthService],
  controllers: [AuthController]
})
export class AuthModule {}
