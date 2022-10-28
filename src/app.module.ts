import { Module } from "@nestjs/common";
import { UserModule } from "./user/user.module";
import { BookModule } from "./book/book.module";
import { AuthModule } from "./auth/auth.module";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "./database/database.module";
import { MongooseModule, MongooseModuleOptions } from "@nestjs/mongoose";
import { MongooseConfig } from "./database/configs/mongoose-config";
import { OrderModule } from "./order/order.module";
import { ConfigModule } from "@nestjs/config";
import { RedisModule, RedisModuleOptions } from "@liaoliaots/nestjs-redis";
import { RedisConfig } from "./database/configs/redis-config";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: process.env.NODE_ENV_FILE
    }),
    JwtModule,
    AuthModule,
    UserModule,
    BookModule,
    OrderModule,
    DatabaseModule,
    MongooseModule.forRootAsync({
      imports: [DatabaseModule],
      useFactory: async (mongooseConfig: MongooseConfig) =>
        <MongooseModuleOptions>{
          uri: mongooseConfig.uri
        },
      inject: [MongooseConfig]
    }),
    RedisModule.forRootAsync(
      {
        imports: [DatabaseModule],
        useFactory: async (redisConfig: RedisConfig) => {
          return <RedisModuleOptions>{
            config: {
              host: redisConfig.host,
              port: redisConfig.port
            }
          };
        },
        inject: [RedisConfig]
      },
      true
    )
  ]
})
export class AppModule {}
