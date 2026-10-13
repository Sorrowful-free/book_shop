// /auth (spec §2): the gateway owns the cookie session — login/register/
// refresh write the httpOnly pair AND return the tokens in the body
// (cookie mode for browsers, Bearer mode for API clients); logout always
// clears the cookies (204) even when RevokeToken fails.
//
// After login/register a guest cart_id cookie → cart.MergeCart into the
// fresh user cart, then the cookie is cleared.

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { JwtVerifier } from "@book-shop/common";
import type { AuthClient, CartClient } from "../clients";
import { AUTH_CLIENT, CART_CLIENT, COOKIE_SECURE } from "../tokens";
import { clearAuthCookies, clearCartCookie, setAuthCookies } from "../cookies";
import {
  extractCartId,
  extractAccessToken,
  extractRefreshToken,
  outgoingMetadata,
  type AuthedRequest
} from "../request-context";
import { AuthGuard } from "../guards";
import { presentUser } from "../presenters";
import { LoginDto, LogoutBodyDto, RefreshBodyDto, RegisterDto } from "../dto";

const logger = new Logger("AuthController");

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AUTH_CLIENT) private readonly auth: AuthClient,
    @Inject(CART_CLIENT) private readonly cart: CartClient,
    @Inject(COOKIE_SECURE) private readonly cookieSecure: boolean,
    private readonly verifier: JwtVerifier
  ) {}

  @Post("register")
  @HttpCode(200)
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const tokens = await this.auth.register(dto);
    setAuthCookies(res, tokens, this.cookieSecure);
    await this.mergeGuestCart(req, res, tokens.accessToken);
    return tokens;
  }

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const tokens = await this.auth.login(dto);
    setAuthCookies(res, tokens, this.cookieSecure);
    await this.mergeGuestCart(req, res, tokens.accessToken);
    return tokens;
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Body() body: RefreshBodyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const refreshToken = extractRefreshToken(req, body);
    if (refreshToken === undefined) {
      throw new BadRequestException("refresh_token required (cookie or body)");
    }
    const tokens = await this.auth.refresh({ refreshToken });
    setAuthCookies(res, tokens, this.cookieSecure);
    return tokens;
  }

  /**
   * Idempotent by design (spec §2): the refresh cookie/body IS the
   * credential — no JWT guard. RevokeToken gets the current access token
   * too so its jti lands in the denylist even when exp already passed.
   * Revoke errors never block logout — cookies are cleared regardless.
   */
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Body() body: LogoutBodyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<void> {
    const refreshToken = extractRefreshToken(req, body);
    const accessToken = extractAccessToken(req);
    if (refreshToken !== undefined) {
      try {
        await this.auth.revokeToken({ refreshToken, accessToken });
      } catch (error) {
        logger.warn(
          "RevokeToken failed during logout — clearing anyway",
          error
        );
      }
    }
    clearAuthCookies(res, this.cookieSecure);
  }

  /**
   * Best-effort guest→user cart merge (spec §2). A failed merge does not
   * fail login: the cookie is kept so a later login retries it (the
   * cart_id cookie is ignored while authenticated anyway).
   */
  private async mergeGuestCart(
    req: Request,
    res: Response,
    accessToken: string
  ): Promise<void> {
    const cartId = extractCartId(req);
    if (cartId === undefined) {
      return;
    }
    try {
      await this.cart.mergeCart(
        { guestCartId: cartId },
        outgoingMetadata(req, accessToken)
      );
      clearCartCookie(res, this.cookieSecure);
    } catch (error) {
      logger.warn("MergeCart failed after login — guest cart kept", error);
    }
  }

  /**
   * user_id comes from the locally verified JWT `sub` (spec §2) — the
   * upstream call still carries the raw token for its own verification.
   */
  @Get("me")
  @UseGuards(AuthGuard)
  async me(@Req() req: AuthedRequest) {
    const { user, accessToken } = req.auth!;
    const result = await this.auth.getUser(
      { userId: user.userId },
      outgoingMetadata(req, accessToken)
    );
    if (!result) {
      throw new NotFoundException();
    }
    return presentUser(result);
  }
}
