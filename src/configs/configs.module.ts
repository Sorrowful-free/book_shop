import { Module } from "@nestjs/common";
import { JwtConfig } from "./jwt-config";
import { MongooseConfig } from "./mongoose-config";

@Module({
  providers: [JwtConfig, MongooseConfig],
  exports: [JwtConfig, MongooseConfig]
})
export class ConfigsModule {}
