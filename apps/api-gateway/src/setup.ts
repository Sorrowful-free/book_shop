// HTTP surface wiring (spec §2/§10): shared between main.ts and the e2e
// harness so tests exercise the exact production setup — global prefix
// `api/v1`, cookie-parser, global ValidationPipe, the gRPC→HTTP error
// filter, CORS with credentials, and swagger on /api/docs (OUTSIDE the
// global prefix — it is the one exception, spec §2).

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { GatewayExceptionFilter } from "./error.filter";

export const GLOBAL_PREFIX = "api/v1";
export const SWAGGER_PATH = "api/docs";

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new GatewayExceptionFilter());
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3001",
    // cookie session requires credentialed CORS (spec §7)
    credentials: true
  });
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("book-shop API")
      .setDescription("api-gateway — REST facade over the gRPC services")
      .setVersion("1.0")
      .build()
  );
  SwaggerModule.setup(SWAGGER_PATH, app, document);
}
