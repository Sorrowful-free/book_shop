import { Body, Controller, Post, UnauthorizedException } from "@nestjs/common";
import { SuccessLoginDto } from "../dto/success-login.dto";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}
  @Post("login")
  login(
    @Body("user_name") username: string,
    @Body("pass") pass: string
  ): SuccessLoginDto {
    return this.authService.login(username, pass);
  }
}
