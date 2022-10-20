import { PartialType, PickType } from "@nestjs/mapped-types";
import { UserDto } from "./user-dto";

export class JwtAccessTokenPayloadDto extends PickType(UserDto, [
  "user_id",
  "user_name",
  "user_role"
]) {}
