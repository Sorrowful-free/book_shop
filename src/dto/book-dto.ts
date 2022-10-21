import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class BookDto {
  @IsNotEmpty()
  readonly book_id: any;
  @IsString()
  readonly book_name: string;
  @IsString()
  readonly author: string;
}
