import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import type { JwtVerifier, UserContext } from "@book-shop/common";
import { EVENT_TYPES, UserRole, type authProto } from "@book-shop/contracts";
import type { TokenDenylistWriter } from "./denylist";
import {
  dummyPasswordHash,
  hashPassword,
  isPasswordValid,
  verifyPassword
} from "./password";
import type { AuthRepository, UserRecord } from "./repository";
import type { TokenClaims, TokenService } from "./tokens";

/**
 * Core auth logic. Errors map to gRPC status codes per spec §8
 * (INVALID_ARGUMENT, ALREADY_EXISTS, UNAUTHENTICATED, NOT_FOUND,
 * PERMISSION_DENIED) via RpcException payloads {code, message} — the base
 * RPC exception filter rethrows the payload so grpc-js serializes the right
 * status on the wire; tests read err.error.code / err.getError().code.
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

// Shared with the boundary DTOs (auth.dto.ts) — one rule, one wording, so
// the boundary check and this defense-in-depth check can't drift (F-A4).
export const USER_NAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/;
export const USER_NAME_MESSAGE = "user_name must be 3-32 chars of [a-zA-Z0-9_]";
const STAFF_ROLES: readonly UserRole[] = [UserRole.Admin, UserRole.Employer];

function grpcError(code: status, message: string): RpcException {
  // Top-level `code` too: the exception may reach grpc-js unwrapped when
  // several gRPC apps share one process, and the wire status is read from
  // `error.code` directly.
  return Object.assign(new RpcException({ code, message }), { code });
}

function unauthenticated(message = "unauthenticated"): RpcException {
  return grpcError(status.UNAUTHENTICATED, message);
}

function isUniqueViolation(error: unknown): boolean {
  // PrismaClientKnownRequestError P2002 — kept stringly-typed so the domain
  // service stays persistence-agnostic (unit tests mock the interface).
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * Creates a CUSTOMER + outbox row in one transaction; returns a token
   * pair (auto-login). Errors: INVALID_ARGUMENT, ALREADY_EXISTS.
   */
  async register(
    request: authProto.RegisterRequest
  ): Promise<authProto.AuthTokens> {
    if (!USER_NAME_PATTERN.test(request.userName)) {
      throw grpcError(status.INVALID_ARGUMENT, USER_NAME_MESSAGE);
    }
    if (!isPasswordValid(request.password)) {
      throw grpcError(
        status.INVALID_ARGUMENT,
        "password must be >= 8 chars with a letter, a digit and a special character"
      );
    }
    if (await this.deps.repository.findUserByName(request.userName)) {
      throw grpcError(status.ALREADY_EXISTS, "user_name is already taken");
    }
    const passwordHash = await hashPassword(request.password);
    try {
      const created = await this.deps.repository.createUserWithOutbox(
        { userName: request.userName, passwordHash, role: UserRole.Customer },
        (user) => ({
          eventType: EVENT_TYPES.userRegistered,
          payload: {
            userId: user.id,
            userName: user.userName,
            role: user.role
          }
        })
      );
      return this.issuePair(created);
    } catch (error) {
      // unique index raced with the existence check
      if (isUniqueViolation(error)) {
        throw grpcError(status.ALREADY_EXISTS, "user_name is already taken");
      }
      throw error;
    }
  }

  /** Errors: INVALID_ARGUMENT, UNAUTHENTICATED (no user-exists oracle). */
  async login(request: authProto.LoginRequest): Promise<authProto.AuthTokens> {
    if (!USER_NAME_PATTERN.test(request.userName)) {
      throw grpcError(status.INVALID_ARGUMENT, USER_NAME_MESSAGE);
    }
    const user = await this.deps.repository.findUserByName(request.userName);
    // Unknown users still run a real argon2id verify against a constant
    // dummy hash — otherwise the missing verify would make login latency
    // leak whether the account exists (timing oracle).
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? (await dummyPasswordHash()),
      request.password
    );
    // same UNAUTHENTICATED for unknown user and wrong password — no oracle
    if (!user || !passwordOk) {
      throw unauthenticated("invalid credentials");
    }
    return this.issuePair(user);
  }

  /**
   * Rotation: old refresh jti is marked revoked, a new pair is issued.
   * Reuse/forged/expired → UNAUTHENTICATED. Revocation is an atomic
   * conditional UPDATE (WHERE revoked_at IS NULL): two concurrent refreshes
   * of the same jti can't both succeed — the loser sees count 0 → replay.
   */
  async refresh(
    request: authProto.RefreshRequest
  ): Promise<authProto.AuthTokens> {
    const claims = await this.deps.tokens.verifyRefreshToken(
      request.refreshToken
    );
    if (!claims) {
      throw unauthenticated("invalid refresh token");
    }
    const stored = await this.deps.repository.findRefreshToken(claims.jti);
    if (!stored || stored.expiresAt.getTime() <= Date.now()) {
      throw unauthenticated("refresh token revoked or expired");
    }
    // rotate: atomically revoke the presented jti — count 0 means the row
    // was already revoked between the read and now (replay/concurrent use)
    const revoked = await this.deps.repository.revokeRefreshToken(
      claims.jti,
      new Date()
    );
    if (revoked === 0) {
      throw unauthenticated("refresh token revoked or expired");
    }
    const user = await this.deps.repository.findUserById(stored.userId);
    if (!user) {
      throw unauthenticated("refresh token owner not found");
    }
    return this.issuePair(user);
  }

  /**
   * Logout: refresh jti → revoked in DB; optional access token is checked
   * by signature only and its jti goes to the Redis denylist with
   * TTL = exp - now (skipped when <= 0). Idempotent.
   * Errors: UNAUTHENTICATED (bad signature).
   */
  async revokeToken(request: authProto.RevokeTokenRequest): Promise<void> {
    const claims = await this.deps.tokens.verifyRefreshToken(
      request.refreshToken
    );
    if (!claims) {
      throw unauthenticated("invalid refresh token");
    }
    const stored = await this.deps.repository.findRefreshToken(claims.jti);
    if (!stored) {
      // validly signed but never issued by us — treat as forged
      throw unauthenticated("unknown refresh token");
    }
    // validate the optional access token by signature only (exp ignored)
    // BEFORE mutating anything — a forged token must fail with no side effects
    let accessClaims: TokenClaims | null = null;
    if (request.accessToken) {
      accessClaims = await this.deps.tokens.verifyAccessSignatureOnly(
        request.accessToken
      );
      if (!accessClaims) {
        throw unauthenticated("invalid access token");
      }
    }
    // atomic revoke — count is ignored on purpose: an already-revoked
    // refresh is still a success (idempotent, spec §2)
    await this.deps.repository.revokeRefreshToken(claims.jti, new Date());
    if (accessClaims) {
      const ttl = (accessClaims.exp ?? 0) - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await this.deps.denylist.revoke(accessClaims.jti, ttl);
      }
      // ttl <= 0 → token already expired, nothing left to deny
    }
  }

  /** Signature + expiry + denylist check; never errors, invalid → valid=false. */
  async validateToken(
    request: authProto.ValidateTokenRequest
  ): Promise<ValidateTokenResult> {
    const user = await this.deps.verifier.verify(request.accessToken);
    if (!user) {
      return { valid: false };
    }
    return { valid: true, user };
  }

  /**
   * Ownership matrix (spec §6): caller must be authenticated; own profile
   * any role, foreign profile ADMIN/EMPLOYER only. Permission is checked
   * BEFORE existence (a customer probing foreign ids gets
   * PERMISSION_DENIED, not NOT_FOUND).
   * Errors: UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND.
   */
  async getUser(
    request: authProto.GetUserRequest,
    caller: UserContext | null
  ): Promise<UserProfile> {
    if (!caller) {
      throw unauthenticated("authentication required");
    }
    const isSelf = caller.userId === request.userId;
    if (!isSelf && !STAFF_ROLES.includes(caller.role)) {
      throw grpcError(
        status.PERMISSION_DENIED,
        "foreign profiles require ADMIN or EMPLOYER"
      );
    }
    const user = await this.deps.repository.findUserById(request.userId);
    if (!user) {
      throw grpcError(status.NOT_FOUND, "user not found");
    }
    return {
      userId: user.id,
      userName: user.userName,
      role: user.role,
      createdAt: user.createdAt
    };
  }

  /** Issue a pair and persist the refresh jti row (spec §11 audit). */
  private async issuePair(user: UserRecord): Promise<authProto.AuthTokens> {
    const pair = await this.deps.tokens.issueTokenPair({
      id: user.id,
      userName: user.userName,
      role: user.role
    });
    await this.deps.repository.createRefreshToken({
      id: pair.refreshJti,
      userId: user.id,
      expiresAt: new Date(Date.now() + pair.refreshTokenExpiresIn * 1000)
    });
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessTokenExpiresIn: pair.accessTokenExpiresIn,
      refreshTokenExpiresIn: pair.refreshTokenExpiresIn
    };
  }
}
