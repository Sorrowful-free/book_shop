import { Module } from "@nestjs/common";
import { RedisConfig } from "./configs/redis-config";
import { TemporaryStorageService } from "./temporary-storage.service";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [ConfigModule],
  providers: [RedisConfig, TemporaryStorageService],
  exports: [RedisConfig, TemporaryStorageService]
})
export class TemporaryStorageModule {}
