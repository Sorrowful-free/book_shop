import { Injectable, NestMiddleware } from "@nestjs/common";

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    console.log(
      "test logs for request method:" + req.method + " path:" + req.path
    );
    next();
  }
}
