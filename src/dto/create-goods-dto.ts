import { GoodsDto } from "./goods-dto";
import { PickType } from "@nestjs/mapped-types";

export class CreateGoodsDto extends PickType(GoodsDto, ["book_id", "amount"]) {}
