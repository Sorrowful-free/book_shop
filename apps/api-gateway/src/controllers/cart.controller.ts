// /cart (spec §2): guest carts (cart_id cookie, auto-created on first
// touch) and user carts (JWT → user cart, cookie ignored) share one REST
// surface — resolveCartOwner decides the mode per request.
//
// Responses are enriched from the catalog — the BFF aggregation. The
// spec's degradation rule: catalog GetBooksByIds fails wholesale NOT_FOUND
// when ANY id is missing, so a missing book must not sink the response —
// fall back to per-book GetBook lookups so the surviving books still
// enrich and only the gone ones degrade to `available: false`.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Metadata, status } from "@grpc/grpc-js";
import { JwtVerifier } from "@book-shop/common";
import type { cartProto, catalogProto } from "@book-shop/contracts";
import { grpcErrorCode, type CartClient, type CatalogClient } from "../clients";
import { CART_CLIENT, CATALOG_CLIENT, COOKIE_SECURE } from "../tokens";
import { setCartCookie } from "../cookies";
import { resolveCartOwner, type AuthedRequest } from "../request-context";
import { enrichCart } from "../presenters";
import { AddCartItemDto, UpdateCartItemDto } from "../dto";

interface CartScope {
  cartId?: string;
  metadata: Metadata;
}

@ApiTags("cart")
@Controller("cart")
export class CartController {
  constructor(
    @Inject(CART_CLIENT) private readonly cart: CartClient,
    @Inject(CATALOG_CLIENT) private readonly catalog: CatalogClient,
    @Inject(COOKIE_SECURE) private readonly cookieSecure: boolean,
    private readonly verifier: JwtVerifier
  ) {}

  @Get()
  async get(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    const scope = await this.scope(req, res);
    const cart = await this.cart.getCart(
      { cartId: scope.cartId },
      scope.metadata
    );
    return this.enriched(cart);
  }

  @Post("items")
  @HttpCode(200)
  async addItem(
    @Body() dto: AddCartItemDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    const scope = await this.scope(req, res);
    const cart = await this.cart.addItem(
      { cartId: scope.cartId, bookId: dto.bookId, amount: dto.amount },
      scope.metadata
    );
    return this.enriched(cart);
  }

  @Patch("items/:book_id")
  async updateItem(
    @Param("book_id") bookId: string,
    @Body() dto: UpdateCartItemDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    const scope = await this.scope(req, res);
    const cart = await this.cart.updateItem(
      { cartId: scope.cartId, bookId, amount: dto.amount },
      scope.metadata
    );
    return this.enriched(cart);
  }

  @Delete("items/:book_id")
  async removeItem(
    @Param("book_id") bookId: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    const scope = await this.scope(req, res);
    const cart = await this.cart.removeItem(
      { cartId: scope.cartId, bookId },
      scope.metadata
    );
    return this.enriched(cart);
  }

  @Delete()
  @HttpCode(204)
  async clear(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    const scope = await this.scope(req, res);
    await this.cart.clearCart({ cartId: scope.cartId }, scope.metadata);
  }

  /**
   * spec §2 owner resolution: a verified JWT → user-cart mode (the cart_id
   * cookie is IGNORED); otherwise guest mode on the cart_id cookie, with
   * CreateCart + a fresh cookie when the guest has none yet.
   */
  private async scope(req: AuthedRequest, res: Response): Promise<CartScope> {
    const owner = await resolveCartOwner(this.verifier, req);
    if (owner.kind === "user") {
      return { metadata: owner.metadata };
    }
    let cartId = owner.cartId;
    if (cartId === undefined) {
      cartId = await this.cart.createCart(owner.metadata);
      setCartCookie(res, cartId, this.cookieSecure);
    }
    return { cartId, metadata: owner.metadata };
  }

  private async enriched(cart: cartProto.Cart) {
    const books = await this.lookupBooks(cart.items.map((item) => item.bookId));
    return enrichCart(cart, books);
  }

  /**
   * GetBooksByIds is all-or-nothing: one missing id fails the whole call
   * with NOT_FOUND. Degrade per-book in that case — gone books yield
   * `available: false` positions while the rest stay enriched.
   */
  private async lookupBooks(bookIds: string[]): Promise<catalogProto.Book[]> {
    const unique = [...new Set(bookIds)];
    if (unique.length === 0) {
      return [];
    }
    try {
      return await this.catalog.getBooksByIds(unique);
    } catch (error) {
      if (grpcErrorCode(error) !== status.NOT_FOUND) {
        throw error;
      }
    }
    const found = await Promise.all(
      unique.map(async (bookId) => {
        try {
          const { book } = await this.catalog.getBook({ bookId });
          return book;
        } catch (error) {
          if (grpcErrorCode(error) === status.NOT_FOUND) {
            return undefined;
          }
          throw error;
        }
      })
    );
    return found.filter(
      (book): book is catalogProto.Book => book !== undefined
    );
  }
}
