import { Module } from "@nestjs/common";

/**
 * Empty composition root for the contract+tests phase. The wiring —
 * CartController, Redis-backed CartRepository, JwtVerifier and the Kafka
 * consumer for `order.order.events` — lands with the implementation
 * (docs/specs/03-cart-service.md). The gRPC server boots and answers every
 * RPC with UNIMPLEMENTED until then, which is what makes the e2e suite fail.
 */
@Module({})
export class AppModule {}
