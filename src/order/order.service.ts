import { Injectable } from "@nestjs/common";
import { TemporaryStorageService } from "../temporary-storage/temporary-storage.service";
import { DatabaseService } from "../database/database.service";
import { CreateOrderDto } from "../dto/create-order-dto";
import { UserDto } from "../dto/user-dto";
import { OrderDto } from "../dto/order-dto";

@Injectable()
export class OrderService {
  constructor(
    private readonly temporaryStorageService: TemporaryStorageService,
    private readonly databaseService: DatabaseService
  ) {}

  store(userDto: UserDto, createOrderDto: CreateOrderDto): Promise<OrderDto> {
    return this.temporaryStorageService.storeOrder({
      order_id: userDto.user_id,
      goods: createOrderDto.goods
    });
  }
  async find(orderId: any): Promise<OrderDto> {
    const order = await this.temporaryStorageService.findOrder(orderId);
    if (order) {
      return order;
    }
    return this.databaseService.findOrder(orderId);
  }
  async delete(orderId: any): Promise<void> {
    await this.temporaryStorageService.deleteOrder(orderId);
    await this.databaseService.deleteOrder(orderId);
  }
  async checkout(
    userDto: UserDto,
    createOrderDto: CreateOrderDto
  ): Promise<OrderDto> {
    await this.temporaryStorageService.deleteOrder(userDto.user_id);
    return this.databaseService.createOrder(createOrderDto);
  }
}
