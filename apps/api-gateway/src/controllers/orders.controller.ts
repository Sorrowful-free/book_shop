// /orders (spec §2): authenticated-only order proxy. Checkout carries the
// Idempotency-Key header through to order.Checkout.idempotency_key; when
// the header is absent the gateway generates a fresh uuid per request.

import { randomUUID } from "node:crypto";
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { OrderClient } from "../clients";
import { ORDER_CLIENT } from "../tokens";
import { outgoingMetadata, type AuthedRequest } from "../request-context";
import { AuthGuard } from "../guards";
import { presentOrder } from "../presenters";
import { OrdersQueryDto } from "../dto";

const DEFAULT_LIMIT = 20;

@ApiTags("orders")
@Controller("orders")
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(@Inject(ORDER_CLIENT) private readonly orders: OrderClient) {}

  @Post("checkout")
  @HttpCode(200)
  async checkout(@Req() req: AuthedRequest) {
    const header = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof header === "string" && header !== "" ? header : randomUUID();
    const order = await this.orders.checkout(
      { idempotencyKey },
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return presentOrder(order);
  }

  @Get()
  async list(@Query() query: OrdersQueryDto, @Req() req: AuthedRequest) {
    const result = await this.orders.listMyOrders(
      { offset: query.offset ?? 0, limit: query.limit ?? DEFAULT_LIMIT },
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return { orders: result.orders.map(presentOrder), total: result.total };
  }

  @Get(":id")
  async get(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    const order = await this.orders.getOrder(
      { orderId: id },
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return presentOrder(order);
  }

  @Post(":id/pay")
  @HttpCode(200)
  async pay(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    const order = await this.orders.payOrder(
      { orderId: id },
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return presentOrder(order);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest
  ) {
    const order = await this.orders.cancelOrder(
      { orderId: id },
      outgoingMetadata(req, req.auth!.accessToken)
    );
    return presentOrder(order);
  }
}
