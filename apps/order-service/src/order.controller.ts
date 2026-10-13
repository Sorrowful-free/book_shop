// gRPC surface for OrderService. Every RPC requires a valid JWT — the
// controller verifies the raw `authorization` metadata itself (defense in
// depth — spec §6) via JwtVerifier and hands the resulting UserContext
// (or null → the service maps UNAUTHENTICATED) plus the raw call metadata
// down; the service forwards `authorization` verbatim to cart/catalog.
//
// Request shape is validated at the boundary: every handler parameter is
// typed as a class-validator DTO and piped through requestValidationPipe —
// violations become RpcException INVALID_ARGUMENT before the domain service
// (or any repository/dependency access) runs. @Ctx() keeps the gRPC call
// Metadata flowing: once a parameter is decorated, undecorated parameters
// no longer receive positional args (AGENTS.md hard rule).

import { Controller } from "@nestjs/common";
import type { Metadata } from "@grpc/grpc-js";
import { Ctx, Payload } from "@nestjs/microservices";
import {
  authorizationFromMetadata,
  GRPC_METADATA_KEYS,
  JwtVerifier,
  requestValidationPipe,
  type UserContext
} from "@book-shop/common";
import { orderProto } from "@book-shop/contracts";
import { OrderService } from "./order.service";
import {
  CancelOrderDto,
  CheckoutDto,
  GetOrderDto,
  ListMyOrdersDto,
  PayOrderDto
} from "./dto";

@Controller()
@orderProto.OrderServiceControllerMethods()
export class OrderController implements orderProto.OrderServiceController {
  constructor(
    private readonly service: OrderService,
    private readonly verifier: JwtVerifier
  ) {}

  async checkout(
    @Payload(requestValidationPipe) request: CheckoutDto,
    @Ctx() metadata?: Metadata
  ): Promise<orderProto.Order> {
    return this.service.checkout(
      request,
      await this.callerFrom(metadata),
      metadata
    );
  }

  async getOrder(
    @Payload(requestValidationPipe) request: GetOrderDto,
    @Ctx() metadata?: Metadata
  ): Promise<orderProto.Order> {
    return this.service.getOrder(request, await this.callerFrom(metadata));
  }

  async listMyOrders(
    @Payload(requestValidationPipe) request: ListMyOrdersDto,
    @Ctx() metadata?: Metadata
  ): Promise<orderProto.ListMyOrdersResponse> {
    return this.service.listMyOrders(request, await this.callerFrom(metadata));
  }

  async payOrder(
    @Payload(requestValidationPipe) request: PayOrderDto,
    @Ctx() metadata?: Metadata
  ): Promise<orderProto.Order> {
    return this.service.payOrder(
      request,
      await this.callerFrom(metadata),
      metadata
    );
  }

  async cancelOrder(
    @Payload(requestValidationPipe) request: CancelOrderDto,
    @Ctx() metadata?: Metadata
  ): Promise<orderProto.Order> {
    return this.service.cancelOrder(
      request,
      await this.callerFrom(metadata),
      metadata
    );
  }

  /** `authorization` metadata → verified UserContext, or null. */
  private async callerFrom(metadata?: Metadata): Promise<UserContext | null> {
    const raw = metadata?.get(GRPC_METADATA_KEYS.authorization)[0];
    if (raw === undefined) {
      return null;
    }
    const token = authorizationFromMetadata({ authorization: String(raw) });
    return token ? this.verifier.verify(token) : null;
  }
}
