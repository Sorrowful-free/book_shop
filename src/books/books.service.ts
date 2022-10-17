import { Injectable } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";

@Injectable()
export class BooksService {
  constructor(private readonly authService: AuthService) {}
}
