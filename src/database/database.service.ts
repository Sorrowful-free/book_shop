import { Injectable, NotFoundException } from "@nestjs/common";
import { UserDto } from "../dto/user-dto";

@Injectable()
export class DatabaseService {
  private readonly users: UserDto[] = [
    { user_id: 1, user_name: "admin", pass: "admin" },
    { user_id: 42, user_name: "vasya", pass: "super_puper_pass" }
  ];
  findUserByUserName(userName: string, pass: string): UserDto | undefined {
    const user = this.users.find((e) => e.user_name === userName);
    if (!user) {
      throw new NotFoundException(`user with username ${userName} not found`);
    }
    return user;
  }

  findUserById(userId: number): UserDto | undefined {
    const user = this.users.find((e) => e.user_id === userId);
    if (!user) {
      throw new NotFoundException(`user with user id ${userId} not found`);
    }
    return user;
  }
}
