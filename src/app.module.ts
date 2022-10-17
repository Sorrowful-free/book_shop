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
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [ConfigsModule, JwtModule, AuthModule, UserModule, BooksModule, DatabaseModule]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
