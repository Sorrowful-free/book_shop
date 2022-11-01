import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type OrderDocument = Order & Document;

@Schema()
export class Goods {
  @Prop()
  readonly book_id: string;
  @Prop()
  readonly description: string;
  @Prop()
  readonly price: number;
  @Prop()
  readonly amount: number;
}

@Schema()
export class Order {
  @Prop()
  order_id: string;
  @Prop({})
  goods: Goods[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);
