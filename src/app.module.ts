import { Module } from "@nestjs/common";
import { UserModule } from "./user/user.module";
import { BookModule } from "./book/book.module";
import { AuthModule } from "./auth/auth.module";
import { ConfigsModule } from "./configs/configs.module";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "./database/database.module";
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "./auth/auth-guards/jwt-auth-guard";

@Module({
  imports: [
    ConfigsModule,
    JwtModule,
    AuthModule,
    UserModule,
    BookModule,
    DatabaseModule
  ]
  //providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }]
})
export class AppModule {}
