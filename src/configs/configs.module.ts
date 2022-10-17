import { Module } from "@nestjs/common";
import { JwtConfig } from "./jwt-config";

@Module({
  providers: [JwtConfig],
  exports: [JwtConfig]
})
export class ConfigsModule {}
