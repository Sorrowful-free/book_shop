import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { UserRole } from "../../dto/user-dto";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly userRole: UserRole) {
    super();
  }

  handleRequest(err: any, user: any, info: any) {
    if (
      err ||
      !user ||
      (this.userRole != UserRole.Any && user.user_role != this.userRole)
    ) {
      throw err || new UnauthorizedException();
    }
    return user;
  }
}

@Injectable()
export class AnyJwtAuthGuard extends JwtAuthGuard {
  constructor() {
    super(UserRole.Any);
  }
}

@Injectable()
export class AdminJwtAuthGuard extends JwtAuthGuard {
  constructor() {
    super(UserRole.Admin);
  }
}

@Injectable()
export class EmployerJwtAuthGuard extends JwtAuthGuard {
  constructor() {
    super(UserRole.Employer);
  }
}

@Injectable()
export class CustomerJwtAuthGuard extends JwtAuthGuard {
  constructor() {
    super(UserRole.Customer);
  }
}
