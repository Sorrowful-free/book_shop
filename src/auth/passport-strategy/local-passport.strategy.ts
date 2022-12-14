import { Strategy } from "passport-local";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { DatabaseService } from "../../database/database.service";
import { UserDto } from "../../dto/user-dto";

@Injectable()
export class LocalPassportStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly databaseService: DatabaseService) {
    super({ usernameField: "login", passwordField: "password" });
  }

  async validate(username: string, password: string): Promise<UserDto> {
    const user = await this.databaseService.findUserByUserName(
      username,
      password
    );

    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
