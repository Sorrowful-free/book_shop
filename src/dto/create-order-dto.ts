import { CreateGoodsDto } from "./create-goods-dto";
import { IsNotEmpty } from "class-validator";

export class CreateOrderDto {
  @IsNotEmpty({ each: true })
  readonly goods: CreateGoodsDto[];
}
