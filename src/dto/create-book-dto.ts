import { PartialType, PickType } from "@nestjs/mapped-types";
import { BookDto } from "./book-dto";

export class CreateBookDto extends PickType(BookDto, ["book_name", "author"]) {}
