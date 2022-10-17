import { PartialType } from "@nestjs/mapped-types";
import { UserDto } from "./user-dto";
import { IsDate } from "class-validator";

export class JwtTokenPayloadDto extends PartialType(UserDto) {
  @IsDate()
  readonly expires_in: Date;
}
