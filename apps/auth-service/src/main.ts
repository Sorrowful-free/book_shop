import "reflect-metadata";
import "dotenv/config";
import { createRequire } from "node:module";
import { NestFactory } from "@nestjs/core";
import { Transport, type MicroserviceOptions } from "@nestjs/microservices";
import { authProto } from "@book-shop/contracts";
import { AppModule } from "./app.module";

/**
 * auth-service bootstrap: NestJS gRPC microservice on 0.0.0.0:$GRPC_PORT
 * (package bookshop.auth.v1, spec §2). protoPath is resolved through the
 * contracts package exports so the file isn't referenced by relative path.
 */
async function bootstrap(): Promise<void> {
  const port = process.env.GRPC_PORT ?? "50051";
  const protoPath = createRequire(import.meta.url).resolve(
    "@book-shop/contracts/proto/auth.proto"
  );
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: authProto.BOOKSHOP_AUTH_V1_PACKAGE_NAME,
        protoPath,
        url: `0.0.0.0:${port}`
      }
    }
  );
  // run OnModuleDestroy (outbox relay stop, prisma/redis/kafka close) on
  // SIGTERM/SIGINT — otherwise termination skips graceful cleanup
  app.enableShutdownHooks();
  await app.listen();
}

bootstrap().catch((error: unknown) => {
  console.error("auth-service failed to start", error);
  process.exitCode = 1;
});
