import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type BookDocument = Book & Document;

@Schema()
export class Book {
  @Prop()
  book_id: string;

  @Prop()
  book_name: string;

  @Prop()
  author: string;
}

export const BookSchema = SchemaFactory.createForClass(Book);
