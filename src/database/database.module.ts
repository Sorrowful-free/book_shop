import { Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { MongooseModule } from "@nestjs/mongoose";
import { Book, BookSchema } from "../mongo-schemas/book";
import { MongooseConfig } from "./configs/mongoose-config";
import { ConfigModule } from "@nestjs/config";
import { Order, OrderSchema } from "../mongo-schemas/order";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Book.name, schema: BookSchema },
      { name: Order.name, schema: OrderSchema }
    ]),
    ConfigModule
  ],
  providers: [MongooseConfig, DatabaseService],
  exports: [MongooseConfig, DatabaseService]
})
export class DatabaseModule {}
