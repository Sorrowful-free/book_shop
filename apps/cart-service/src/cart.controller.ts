import { Controller } from "@nestjs/common";
import type { Metadata } from "@grpc/grpc-js";
import { Ctx, EventPattern, Payload, Transport } from "@nestjs/microservices";
import {
  authorizationFromMetadata,
  GRPC_METADATA_KEYS,
  JwtVerifier,
  type UserContext
} from "@book-shop/common";
import {
  cartProto,
  EVENT_TYPES,
  KAFKA_TOPICS,
  type DomainEvent,
  type OrderCreatedPayload
} from "@book-shop/contracts";
import { CartService } from "./cart.service";
import {
  AddItemDto,
  ClearCartDto,
  GetCartDto,
  MergeCartDto,
  RemoveItemDto,
  UpdateItemDto,
  requestValidationPipe
} from "./dto";

/**
 * gRPC entry point (docs/specs/03-cart-service.md §2).
 *
 * Each RPC resolves the caller from the raw JWT in `authorization` metadata
 * (EdDSA + Redis denylist via {@link JwtVerifier}) and hands it to the domain
 * service — `null` means "no valid token" and the service decides whether the
 * operation needs one (guest carts addressed by `cart_id` don't).
 */
@Controller()
@cartProto.CartServiceControllerMethods()
export class CartController implements cartProto.CartServiceController {
  constructor(
    private readonly cartService: CartService,
    private readonly jwtVerifier: JwtVerifier
  ) {}

  async createCart(): Promise<cartProto.CreateCartResponse> {
    return this.cartService.createCart();
  }

  async getCart(
    @Payload(requestValidationPipe) request: GetCartDto,
    @Ctx() metadata?: Metadata
  ): Promise<cartProto.Cart> {
    return this.cartService.getCart(request, await this.caller(metadata));
  }

  async addItem(
    @Payload(requestValidationPipe) request: AddItemDto,
    @Ctx() metadata?: Metadata
  ): Promise<cartProto.Cart> {
    return this.cartService.addItem(request, await this.caller(metadata));
  }

  async updateItem(
    @Payload(requestValidationPipe) request: UpdateItemDto,
    @Ctx() metadata?: Metadata
  ): Promise<cartProto.Cart> {
    return this.cartService.updateItem(request, await this.caller(metadata));
  }

  async removeItem(
    @Payload(requestValidationPipe) request: RemoveItemDto,
    @Ctx() metadata?: Metadata
  ): Promise<cartProto.Cart> {
    return this.cartService.removeItem(request, await this.caller(metadata));
  }

  async clearCart(
    @Payload(requestValidationPipe) request: ClearCartDto,
    @Ctx() metadata?: Metadata
  ): Promise<void> {
    await this.cartService.clearCart(request, await this.caller(metadata));
  }

  async mergeCart(
    @Payload(requestValidationPipe) request: MergeCartDto,
    @Ctx() metadata?: Metadata
  ): Promise<cartProto.Cart> {
    return this.cartService.mergeCart(request, await this.caller(metadata));
  }

  /**
   * Kafka consumer entry point (spec §4): `order.order.events` /
   * `order.order.created` → clear the user's cart. Internal, unauthenticated,
   * best-effort; deletion is idempotent.
   */
  @EventPattern(KAFKA_TOPICS.orderOrderEvents, Transport.KAFKA)
  async handleOrderEvent(
    @Payload() event: DomainEvent<OrderCreatedPayload>
  ): Promise<void> {
    if (event?.eventType !== EVENT_TYPES.orderCreated) {
      return;
    }
    await this.cartService.handleOrderCreated(event.payload);
  }

  /**
   * `authorization` metadata → verified UserContext; `null` for a missing,
   * malformed, expired or revoked token — all map to UNAUTHENTICATED on
   * RPCs that require a user cart.
   */
  private async caller(metadata?: Metadata): Promise<UserContext | null> {
    const values = metadata?.get(GRPC_METADATA_KEYS.authorization);
    const raw = values?.length ? String(values[0]) : undefined;
    const token = raw
      ? authorizationFromMetadata({ authorization: raw })
      : undefined;
    return token ? this.jwtVerifier.verify(token) : null;
  }
}
