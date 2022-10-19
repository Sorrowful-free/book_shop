import { IsString } from "class-validator";

export class UserDto {
  @IsString()
  readonly userid: number;
  @IsString()
  readonly username: string;
  @IsString()
  readonly password: string;
}
