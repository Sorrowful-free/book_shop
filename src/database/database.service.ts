import { Injectable, NotFoundException } from "@nestjs/common";
import { UserDto } from "../dto/user-dto";

@Injectable()
export class DatabaseService {
  private readonly users: UserDto[] = [
    { userid: 1, username: "admin", password: "admin" },
    { userid: 42, username: "vasya", password: "super_puper_pass" }
  ];
  findUserByUserName(
    userName: string,
    pass: string
  ): Promise<UserDto> | Promise<undefined> {
    const user = this.users.find((e) => e.username === userName);
    if (!user || user.password !== pass) {
      throw new NotFoundException(`user with username ${userName} not found`);
    }
    return Promise.resolve(user);
  }

  findUserById(userId: number): Promise<UserDto> | Promise<undefined> {
    const user = this.users.find((e) => e.userid === userId);
    if (!user) {
      throw new NotFoundException(`user with user id ${userId} not found`);
    }
    return Promise.resolve(user);
  }
}
