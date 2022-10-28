import { Module } from "@nestjs/common";
import { UserModule } from "./user/user.module";
import { BookModule } from "./book/book.module";
import { AuthModule } from "./auth/auth.module";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "./database/database.module";
import { MongooseModule } from "@nestjs/mongoose";
import { MongooseConfig } from "./database/configs/mongoose-config";
import { OrderModule } from "./order/order.module";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: process.env.NODE_ENV_FILE
    }),
    JwtModule,
    AuthModule,
    UserModule,
    BookModule,
    DatabaseModule,
    MongooseModule.forRootAsync({
      imports: [DatabaseModule],
      useFactory: async (mongooseConfig: MongooseConfig) => ({
        uri: mongooseConfig.uri
      }),
      inject: [MongooseConfig]
    }),
    OrderModule
  ]
})
export class AppModule {}
