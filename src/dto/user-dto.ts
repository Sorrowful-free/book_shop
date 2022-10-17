import { IsString } from "class-validator";

export class UserDto {
  @IsString()
  readonly user_id: number;
  @IsString()
  readonly user_name: string;
  @IsString()
  readonly pass: string;
}
