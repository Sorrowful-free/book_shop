import { Module } from "@nestjs/common";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { TemporaryStorageModule } from "../temporary-storage/temporary-storage.module";
import { DatabaseModule } from "../database/database.module";

@Module({
  imports: [TemporaryStorageModule, DatabaseModule],
  controllers: [OrderController],
  providers: [OrderService]
})
export class OrderModule {}
