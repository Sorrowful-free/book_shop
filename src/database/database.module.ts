import { Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { MongooseModule } from "@nestjs/mongoose";
import { Book, BookSchema } from "../mongo-schemas/book";
import { MongooseConfig } from "./configs/mongoose-config";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Book.name, schema: BookSchema }]),
    ConfigModule
  ],
  providers: [DatabaseService, MongooseConfig],
  exports: [DatabaseService, MongooseConfig]
})
export class DatabaseModule {}
