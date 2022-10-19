import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod
} from "@nestjs/common";
import { UserModule } from "./user/user.module";
import { BooksModule } from "./books/books.module";
import { AuthModule } from "./auth/auth.module";
import { ConfigsModule } from "./configs/configs.module";
import { LoggerMiddleware } from "./middlewares/logger.middleware";
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
    BooksModule,
    DatabaseModule
  ],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
