import { IsEnum, IsNumber, IsString } from "class-validator";

export enum UserRole {
  None,
  Admin,
  Employer,
  Customer
}

export class UserDto {
  @IsNumber()
  readonly user_id: any;
  @IsString()
  readonly user_name: string;
  @IsString()
  readonly password: string;
  @IsEnum(UserRole)
  readonly user_role: UserRole;

  readonly current_order_id?: any;
  readonly orders_ids?: any[];
}
