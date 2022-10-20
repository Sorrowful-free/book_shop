import { Request, Controller, Post, UseGuards } from "@nestjs/common";
import { AuthTokensDto } from "../dto/auth-tokens.dto";
import { AuthService } from "./auth.service";
import { LocalAuthGuard } from "./auth-guards/local-auth-guard";
import { User } from "../decorators/user.decorator";
import { JwtAccessTokenPayloadDto } from "../dto/jwt-access-token-payload-dto";
import { AnyJwtAuthGuard, JwtAuthGuard } from "./auth-guards/jwt-auth-guard";
import { UserDto } from "../dto/user-dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(LocalAuthGuard)
  @Post("login")
  async login(@User() user: UserDto): Promise<AuthTokensDto> {
    const { user_name, password } = user;
    return this.authService.login(user_name, password);
  }

  @UseGuards(AnyJwtAuthGuard)
  @Post("refresh")
  async refresh(
    @User() user: JwtAccessTokenPayloadDto
  ): Promise<AuthTokensDto> {
    const { user_id } = user;
    console.log(JSON.stringify(user));
    return this.authService.refresh(user_id);
  }

  @UseGuards(JwtAuthGuard)
  @Post("test")
  async test(@User() user: JwtAccessTokenPayloadDto): Promise<any> {
    console.log(JSON.stringify(user));
    return Promise.resolve(user);
  }
}
