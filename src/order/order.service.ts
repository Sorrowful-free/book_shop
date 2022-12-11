import { Injectable, NotAcceptableException } from "@nestjs/common";
import { TemporaryStorageService } from "../temporary-storage/temporary-storage.service";
import { DatabaseService } from "../database/database.service";
import { CreateOrderDto } from "../dto/create-order-dto";
import { UserDto } from "../dto/user-dto";
import { OrderDto } from "../dto/order-dto";
import { GoodsDto } from "../dto/goods-dto";

@Injectable()
export class OrderService {
  constructor(
    private readonly temporaryStorageService: TemporaryStorageService,
    private readonly databaseService: DatabaseService
  ) {}

  async store(
    userDto: UserDto,
    createOrderDto: CreateOrderDto
  ): Promise<OrderDto> {
    return this.temporaryStorageService.storeOrder(
      await this.convertOrder(userDto.user_id, createOrderDto)
    );
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

  private async convertOrder(
    orderId: any,
    createOrderDto: CreateOrderDto
  ): Promise<OrderDto> {
    const booksDtos = await this.databaseService.findBooksByIds(
      createOrderDto.goods.map((e) => e.book_id)
    );
    if (booksDtos.length != createOrderDto.goods.length) {
      throw new NotAcceptableException(null, "not found some books for order");
    }

    const createGoodsDtos = createOrderDto.goods;
    const goodsDto = [];
    for (let i = 0; i < booksDtos.length; i++) {
      const bookDto = booksDtos[i];
      const createGoodsDto = createGoodsDtos[i];
      goodsDto[i] = <GoodsDto>{
        book_id: createGoodsDto.book_id,
        description: `${bookDto.book_name} written by ${bookDto.author}`,
        amount: createGoodsDto.amount,
        price: bookDto.price
      };
    }
    return {
      order_id: orderId,
      goods: goodsDto
    };
  }
}
