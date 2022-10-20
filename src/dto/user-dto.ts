import { IsEnum, IsNumber, IsString } from "class-validator";

export enum UserRole {
  Any,
  Admin,
  Employer,
  Customer
}

export class UserDto {
  @IsNumber()
  readonly user_id: number;
  @IsString()
  readonly user_name: string;
  @IsString()
  readonly password: string;
  @IsEnum(UserRole)
  readonly user_role: UserRole;
}
