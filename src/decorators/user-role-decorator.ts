import { SetMetadata } from "@nestjs/common";
import { UserRole } from "../dto/user-dto";

export const USER_ROLES_KEY = "roles";
export const UserRoles = (...roles: UserRole[]) =>
  SetMetadata(USER_ROLES_KEY, roles);
