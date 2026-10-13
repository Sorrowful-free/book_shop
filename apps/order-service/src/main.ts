// order-service entry point — NestJS gRPC microservice on :50054.
// Runs under Node.js and Bun (no Bun-only APIs; dotenv loads the per-app
// .env in dev).

import "reflect-metadata";
import "dotenv/config";
import { createRequire } from "node:module";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Transport, type MicroserviceOptions } from "@nestjs/microservices";
import { orderProto } from "@book-shop/contracts";
import { AppModule } from "./app.module";

const require = createRequire(import.meta.url);
const PROTO_PATH = require.resolve("@book-shop/contracts/proto/order.proto");

async function bootstrap(): Promise<void> {
  const port = Number(process.env.GRPC_PORT ?? 50054);
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: orderProto.BOOKSHOP_ORDER_V1_PACKAGE_NAME,
        protoPath: PROTO_PATH,
        url: `0.0.0.0:${port}`
      }
    }
  );
  // SIGTERM/SIGINT → onModuleDestroy: stops the outbox relay and closes
  // the Kafka producer / gRPC clients / Redis client / Prisma pool cleanly.
  app.enableShutdownHooks();
  await app.listen();
  new Logger("Bootstrap").log(`order-service gRPC listening on :${port}`);
}

bootstrap().catch((error: unknown) => {
  new Logger("Bootstrap").error("order-service failed to start", error);
  process.exit(1);
});
