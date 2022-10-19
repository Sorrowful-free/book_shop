import { Request, Controller, Post, UseGuards } from "@nestjs/common";
import { AuthTokensDto } from "../dto/auth-tokens.dto";
import { AuthService } from "./auth.service";
import { LocalAuthGuard } from "./auth-guards/local-auth-guard";
import { JwtAuthGuard } from "./auth-guards/jwt-auth-guard";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}
  @UseGuards(LocalAuthGuard)
  @Post("login")
  async login(@Request() request: any): Promise<AuthTokensDto> {
    const user = request.user;
    const { username, password } = user;
    return this.authService.login(username, password);
  }

  @Post("refresh")
  async refresh(@Request() request: any): Promise<AuthTokensDto> {
    const user = request.user;
    const { userid } = user;
    return this.authService.refresh(userid);
  }
}
