import { IsNumber, IsString } from "class-validator";

export class BookDto {
  @IsNumber()
  readonly book_id: number;
  @IsString()
  readonly book_name: string;
  @IsString()
  readonly author: string;
}
