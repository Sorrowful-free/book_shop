import "reflect-metadata";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";

config();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Flush Nest's shutdown lifecycle (OnModuleDestroy → grpc client/redis
  // closes) on SIGTERM/SIGINT instead of hard-exiting.
  app.enableShutdownHooks();
  configureApp(app);
  const port = Number(process.env.PORT ?? "3000");
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  console.error("api-gateway failed to start", error);
  process.exitCode = 1;
});
