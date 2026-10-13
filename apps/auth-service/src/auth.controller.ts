import { Controller } from "@nestjs/common";
import { Ctx, Payload } from "@nestjs/microservices";
import type { Metadata } from "@grpc/grpc-js";
import {
  JwtVerifier,
  GRPC_METADATA_KEYS,
  requestValidationPipe,
  type UserContext
} from "@book-shop/common";
import { authProto, UserRole } from "@book-shop/contracts";
import {
  GetUserDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RevokeTokenDto,
  ValidateTokenDto
} from "./auth.dto";
import { AuthService, type UserProfile } from "./auth.service";

/**
 * gRPC controller implementing the generated authProto.AuthServiceController.
 * Every request DTO is shape-validated at the boundary
 * (@Payload(requestValidationPipe) → INVALID_ARGUMENT on violations, F-A4)
 * before AuthService runs. Register/Login/Refresh/RevokeToken/ValidateToken
 * are public; GetUser verifies the `authorization` metadata JWT (EdDSA
 * public key + Redis denylist via JwtVerifier) and hands the UserContext
 * to AuthService.
 */
@Controller()
@authProto.AuthServiceControllerMethods()
export class AuthController implements authProto.AuthServiceController {
  constructor(
    private readonly service: AuthService,
    private readonly verifier: JwtVerifier
  ) {}

  register(
    @Payload(requestValidationPipe) request: RegisterDto
  ): Promise<authProto.AuthTokens> {
    return this.service.register(request);
  }

  login(
    @Payload(requestValidationPipe) request: LoginDto
  ): Promise<authProto.AuthTokens> {
    return this.service.login(request);
  }

  refresh(
    @Payload(requestValidationPipe) request: RefreshDto
  ): Promise<authProto.AuthTokens> {
    return this.service.refresh(request);
  }

  revokeToken(
    @Payload(requestValidationPipe) request: RevokeTokenDto
  ): Promise<void> {
    return this.service.revokeToken(request);
  }

  async validateToken(
    @Payload(requestValidationPipe) request: ValidateTokenDto
  ): Promise<authProto.ValidateTokenResponse> {
    const result = await this.service.validateToken(request);
    return {
      valid: result.valid,
      user: result.user ? toProtoUserContext(result.user) : undefined
    };
  }

  async getUser(
    @Payload(requestValidationPipe) request: GetUserDto,
    // @Ctx() is required — once any param is decorated, Nest stops applying
    // the default grpc callback metadata to undecorated args.
    @Ctx() metadata?: Metadata
  ): Promise<authProto.User> {
    const caller = await this.callerFromMetadata(metadata);
    const profile = await this.service.getUser(request, caller);
    return toProtoUser(profile);
  }

  /**
   * Extract and verify the raw JWT from `authorization` metadata.
   * Returns null when absent/invalid/revoked — AuthService maps that to
   * UNAUTHENTICATED.
   */
  private callerFromMetadata(metadata?: Metadata): Promise<UserContext | null> {
    const raw = metadata?.get(GRPC_METADATA_KEYS.authorization)?.[0];
    if (raw === undefined || raw === null) {
      return Promise.resolve(null);
    }
    const value = String(raw);
    const token = value.startsWith("Bearer ") ? value.slice(7) : value;
    return this.verifier.verify(token);
  }
}

function toProtoRole(role: UserRole): authProto.Role {
  switch (role) {
    case UserRole.Admin:
      return authProto.Role.ROLE_ADMIN;
    case UserRole.Employer:
      return authProto.Role.ROLE_EMPLOYER;
    case UserRole.Customer:
      return authProto.Role.ROLE_CUSTOMER;
    default:
      return authProto.Role.ROLE_UNSPECIFIED;
  }
}

function toProtoUserContext(user: UserContext): authProto.UserContext {
  return {
    userId: user.userId,
    userName: user.userName,
    role: toProtoRole(user.role)
  };
}

function toProtoUser(profile: UserProfile): authProto.User {
  const ms = profile.createdAt?.getTime();
  return {
    userId: profile.userId,
    userName: profile.userName,
    role: toProtoRole(profile.role),
    createdAt:
      ms === undefined
        ? undefined
        : {
            seconds: Math.floor(ms / 1000),
            nanos: (ms % 1000) * 1_000_000
          }
  };
}
