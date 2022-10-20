import { Module } from "@nestjs/common";
import { BookService } from "./book.service";
import { BookController } from "./book.controller";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [BookService],
  controllers: [BookController]
})
export class BookModule {}
