import type { JwtVerifier, UserContext } from "@book-shop/common";
import type { authProto, UserRole } from "@book-shop/contracts";
import type { TokenDenylistWriter } from "./denylist";
import type { AuthRepository } from "./repository";
import type { TokenService } from "./tokens";

/**
 * Core auth logic — TYPE DECLARATIONS ONLY (TDD contract phase).
 * Implemented later behind the generated authProto.AuthServiceController;
 * errors map to gRPC status codes per spec §8 (INVALID_ARGUMENT,
 * ALREADY_EXISTS, UNAUTHENTICATED, NOT_FOUND, PERMISSION_DENIED).
 */

export interface AuthServiceDeps {
  repository: AuthRepository;
  tokens: TokenService;
  /** Redis denylist writer — auth-service is the only writer (spec §2). */
  denylist: TokenDenylistWriter;
  /** EdDSA verifier + denylist reads, shared with all services. */
  verifier: JwtVerifier;
}

/** Domain-level validateToken result (role is the shared UserRole string). */
export interface ValidateTokenResult {
  valid: boolean;
  user?: UserContext;
}

/** Domain-level user profile for GetUser (never exposes passwordHash). */
export interface UserProfile {
  userId: string;
  userName: string;
  role: UserRole;
  createdAt?: Date;
}

export declare class AuthService {
  constructor(deps: AuthServiceDeps);

  /**
   * Creates a CUSTOMER + outbox row in one transaction; returns a token
   * pair (auto-login). Errors: INVALID_ARGUMENT, ALREADY_EXISTS.
   */
  register(request: authProto.RegisterRequest): Promise<authProto.AuthTokens>;

  /** Errors: INVALID_ARGUMENT, UNAUTHENTICATED (no user-exists oracle). */
  login(request: authProto.LoginRequest): Promise<authProto.AuthTokens>;

  /**
   * Rotation: old refresh jti is marked revoked, a new pair is issued.
   * Reuse/forged/expired → UNAUTHENTICATED.
   */
  refresh(request: authProto.RefreshRequest): Promise<authProto.AuthTokens>;

  /**
   * Logout: refresh jti → revoked in DB; optional access token is checked
   * by signature only and its jti goes to the Redis denylist with
   * TTL = exp - now (skipped when <= 0). Idempotent.
   * Errors: UNAUTHENTICATED (bad signature).
   */
  revokeToken(request: authProto.RevokeTokenRequest): Promise<void>;

  /** Signature + expiry + denylist check; never errors, invalid → valid=false. */
  validateToken(
    request: authProto.ValidateTokenRequest
  ): Promise<ValidateTokenResult>;

  /**
   * Ownership matrix (spec §6): caller must be authenticated; own profile
   * any role, foreign profile ADMIN/EMPLOYER only.
   * Errors: UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND.
   */
  getUser(
    request: authProto.GetUserRequest,
    caller: UserContext | null
  ): Promise<UserProfile>;
}
