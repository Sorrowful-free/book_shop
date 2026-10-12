import { importSPKI, jwtVerify } from "jose";
import { UserRole } from "@book-shop/contracts";
import type { UserContext } from "./user-context";

export interface TokenDenylist {
  isRevoked(jti: string): Promise<boolean>;
}

export class RedisTokenDenylist implements TokenDenylist {
  constructor(
    private readonly client: { get(key: string): Promise<string | null> },
    private readonly prefix = "auth:revoked:"
  ) {}

  async isRevoked(jti: string): Promise<boolean> {
    return (await this.client.get(this.prefix + jti)) !== null;
  }
}

export interface JwtVerifierOptions {
  publicKey: string;
  denylist?: TokenDenylist;
}

export class JwtVerifier {
  private readonly keyPromise: Promise<CryptoKey>;
  /** Resolves once the public key is imported; rejects on a malformed key. */
  private readonly ready: Promise<void>;

  constructor(private readonly options: JwtVerifierOptions) {
    const pem = options.publicKey.startsWith("-----BEGIN")
      ? options.publicKey
      : Buffer.from(options.publicKey, "base64").toString("utf8");
    this.keyPromise = importSPKI(pem, "EdDSA");
    this.ready = this.keyPromise.then(() => undefined);
    // mark handled so a bad key never trips unhandledRejection — the
    // rejection still surfaces to onModuleInit and verify()
    this.ready.catch(() => undefined);
  }

  /**
   * Nest lifecycle hook (duck-typed — JwtVerifier is a plain provider):
   * a malformed JWT_PUBLIC_KEY fails app bootstrap instead of silently
   * rejecting every token forever.
   */
  async onModuleInit(): Promise<void> {
    await this.ready;
  }

  async verify(token: string): Promise<UserContext | null> {
    try {
      const { payload } = await jwtVerify(token, await this.keyPromise, {
        algorithms: ["EdDSA"]
      });
      // strict token typing: only access tokens authenticate bearer calls —
      // a refresh token (typ="refresh") or a typ-less token is rejected
      // here, so a revoked-refresh replay can't act as an access token
      if (
        payload.typ !== "access" ||
        !payload.sub ||
        typeof payload.role !== "string"
      ) {
        return null;
      }
      if (
        this.options.denylist &&
        typeof payload.jti === "string" &&
        (await this.options.denylist.isRevoked(payload.jti))
      ) {
        return null;
      }
      return {
        userId: payload.sub,
        userName:
          typeof payload.user_name === "string" ? payload.user_name : "",
        role: payload.role as UserRole,
        jti: typeof payload.jti === "string" ? payload.jti : undefined
      };
    } catch {
      return null;
    }
  }
}
