import { Injectable } from "@nestjs/common";

@Injectable()
export class MongooseConfig {
  uri = "mongodb://localhost";
}
