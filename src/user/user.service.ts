import { Injectable } from "@nestjs/common";

@Injectable()
export class UserService {
  currentUserName(): string {
    return "user_name";
  }
}
