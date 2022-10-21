import { Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { MongooseModule } from "@nestjs/mongoose";
import { Book, BookSchema } from "../mongo-schemas/book";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Book.name, schema: BookSchema }])
  ],
  providers: [DatabaseService],
  exports: [DatabaseService]
})
export class DatabaseModule {}
