import { Module } from "@nestjs/common";
import { UserModule } from "./user/user.module";
import { BookModule } from "./book/book.module";
import { AuthModule } from "./auth/auth.module";
import { ConfigsModule } from "./configs/configs.module";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "./database/database.module";
import { MongooseModule } from "@nestjs/mongoose";
import { MongooseConfig } from "./configs/mongoose-config";

@Module({
  imports: [
    ConfigsModule,
    JwtModule,
    AuthModule,
    UserModule,
    BookModule,
    DatabaseModule,
    MongooseModule.forRootAsync({
      imports: [ConfigsModule],
      useFactory: async (mongooseConfig: MongooseConfig) => ({
        uri: mongooseConfig.uri
      }),
      inject: [MongooseConfig]
    })
  ]
})
export class AppModule {}
