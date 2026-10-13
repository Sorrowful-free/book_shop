// Gateway auth enforcement (spec §3): AuthGuard verifies the JWT locally
// (JwtVerifier — signature + Redis denylist) and attaches RequestAuth;
// RolesGuard + @Roles enforce the role matrix from spec §2 as the first
// level of defense (services re-check on their side — defense in depth).

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@book-shop/contracts";
import { JwtVerifier } from "@book-shop/common";
import { authenticate, type AuthedRequest } from "./request-context";

export const ROLES_KEY = "roles";

/** Roles allowed on a route; absent/empty → any authenticated user. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly verifier: JwtVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = await authenticate(this.verifier, req);
    if (!auth) {
      throw new UnauthorizedException();
    }
    req.auth = auth;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (required === undefined || required.length === 0) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.auth;
    if (!auth) {
      // A @Roles route without AuthGuard — misconfiguration or a request
      // that slipped through; never authorize it.
      throw new UnauthorizedException();
    }
    if (!required.includes(auth.user.role)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
