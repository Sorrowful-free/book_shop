import { Body, Controller, Delete, Get, UseGuards } from "@nestjs/common";
import { UserRole } from "../dto/user-dto";
import { UserRoles } from "../decorators/user-role-decorator";
import { JwtAuthGuard } from "../auth/auth-guards/jwt-auth-guard";
import { UserRolesAuthGuard } from "../auth/auth-guards/user-roles-auth-guard";

@Controller("order")
export class OrderController {
  @UserRoles(UserRole.Customer, UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Get()
  getCurrent(): Promise<any> {
    return Promise.resolve();
  }

  @UserRoles(UserRole.Customer, UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Get("get")
  get(@Body("order_id") order_id: any): Promise<any> {
    return Promise.resolve();
  }

  @UserRoles(UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Delete("delete")
  delete(@Body("order_id") order_id: any): Promise<any> {
    return Promise.resolve();
  }
}
