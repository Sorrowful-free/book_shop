import { PickType } from "@nestjs/mapped-types";
import { OrderDto } from "./order-dto";

export class CreateOrderDto extends PickType(OrderDto, ["goods"]) {}
