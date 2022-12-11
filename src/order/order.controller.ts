import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { UserDto, UserRole } from "../dto/user-dto";
import { UserRoles } from "../decorators/user-role-decorator";
import { JwtAuthGuard } from "../auth/auth-guards/jwt-auth-guard";
import { UserRolesAuthGuard } from "../auth/auth-guards/user-roles-auth-guard";
import { User } from "../decorators/user-decorator";
import { OrderDto } from "../dto/order-dto";
import { CreateOrderDto } from "../dto/create-order-dto";
import { OrderService } from "./order.service";

@Controller("order")
export class OrderController {
  constructor(private readonly orderService: OrderService) { }

  @UserRoles(UserRole.Customer, UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Get()
  getCurrent(@User() userDto: UserDto): Promise<OrderDto> {
    return this.orderService.find(userDto.user_id);
  }

  @UserRoles(UserRole.Customer, UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Get(":id")
  get(@Query("id") order_id: any): Promise<any> {
    return this.orderService.find(order_id);
  }

  @UserRoles(UserRole.Customer, UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Post()
  store(
    @User() userDto: UserDto,
    @Body() createOrderDto: CreateOrderDto
  ): Promise<OrderDto> {
    return this.orderService.store(userDto, createOrderDto);
  }

  @UserRoles(UserRole.Customer, UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Post("checkout")
  checkout(
    @User() userDto: UserDto,
    @Body() createOrderDto: CreateOrderDto
  ): Promise<OrderDto> {
    return this.orderService.checkout(userDto, createOrderDto);
  }

  @UserRoles(UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Delete("delete/:id")
  deleteCurrent(@User() userDto: UserDto): Promise<any> {
    return this.orderService.delete(userDto.user_id);
  }

  @UserRoles(UserRole.Employer, UserRole.Admin)
  @UseGuards(JwtAuthGuard, UserRolesAuthGuard)
  @Delete("delete/:id")
  delete(@Query("id") order_id: any): Promise<any> {
    return this.orderService.delete(order_id);
  }
}
