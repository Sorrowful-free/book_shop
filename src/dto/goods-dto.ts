import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class GoodsDto {
  @IsNotEmpty()
  readonly book_id: any;
  @IsString()
  readonly description: string;
  @IsNumber()
  readonly price: number;
  @IsNumber()
  readonly amount: number;
}
