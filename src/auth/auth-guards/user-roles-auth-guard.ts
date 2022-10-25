import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { UserRole } from "../../dto/user-dto";
import { USER_ROLES_KEY } from "../../decorators/user-role-decorator";
import { Reflector } from "@nestjs/core";

@Injectable()
export class UserRolesAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      USER_ROLES_KEY,
      [context.getHandler(), context.getClass()]
    );
    if (!requiredRoles) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const { user } = request;
    return requiredRoles.some((user_role) => user.user_role == user_role);
  }
}
