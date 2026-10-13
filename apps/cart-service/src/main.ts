import "reflect-metadata";
import { createRequire } from "node:module";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { Transport, type MicroserviceOptions } from "@nestjs/microservices";
import { Partitioners } from "kafkajs";
import { cartProto } from "@book-shop/contracts";
import { AppModule } from "./app.module";

config();

const PROTO_PATH = createRequire(import.meta.url).resolve(
  "@book-shop/contracts/proto/cart.proto"
);

/**
 * Hybrid bootstrap (docs/specs/03-cart-service.md §4): gRPC server on
 * GRPC_PORT plus a Kafka consumer on `order.order.events`
 * (group `cart-service`). kafkajs retries the broker connection, so the
 * service still boots while infra is coming up.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Flush Nest's shutdown lifecycle (OnModuleDestroy → redis.disconnect,
  // microservice transports) on SIGTERM/SIGINT instead of hard-exiting.
  app.enableShutdownHooks();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: cartProto.BOOKSHOP_CART_V1_PACKAGE_NAME,
      protoPath: PROTO_PATH,
      url: `0.0.0.0:${process.env.GRPC_PORT ?? "50053"}`
    }
  });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: "cart-service",
        brokers: (process.env.KAFKA_BROKERS ?? "localhost:29092").split(",")
      },
      consumer: { groupId: "cart-service" },
      // ServerKafka spawns an internal producer for replies — pin the
      // pre-v2 partitioner to silence the KafkaJS v2 warning.
      producer: { createPartitioner: Partitioners.LegacyPartitioner }
    }
  });
  await app.startAllMicroservices();
  await app.init();
}

bootstrap().catch((error: unknown) => {
  console.error("cart-service failed to start", error);
  process.exitCode = 1;
});
