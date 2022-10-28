import { Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { MongooseModule } from "@nestjs/mongoose";
import { Book, BookSchema } from "../mongo-schemas/book";
import { MongooseConfig } from "./configs/mongoose-config";
import { ConfigModule } from "@nestjs/config";
import { TempDatabaseService } from "./temp-database.service";
import { RedisConfig } from "./configs/redis-config";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Book.name, schema: BookSchema }]),
    ConfigModule
  ],
  providers: [
    MongooseConfig,
    RedisConfig,
    DatabaseService,
    TempDatabaseService
  ],
  exports: [MongooseConfig, RedisConfig, DatabaseService, TempDatabaseService]
})
export class DatabaseModule {}
