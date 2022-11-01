import { IsNotEmpty } from "class-validator";
import { GoodsDto } from "./goods-dto";

export class OrderDto {
  @IsNotEmpty()
  readonly order_id: any;
  @IsNotEmpty({ each: true })
  readonly goods: GoodsDto[];
}
