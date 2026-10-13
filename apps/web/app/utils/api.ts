/**
 * REST shapes mirrored from the api-gateway presenters
 * (apps/api-gateway/src/presenters.ts). Kept as local type aliases — the web
 * app has no workspace dependency on the gateway.
 */

export type UserRole = "ADMIN" | "EMPLOYER" | "CUSTOMER" | "NONE" | string;

export interface RestUser {
  userId: string;
  userName: string;
  role: UserRole;
  createdAt?: string;
}

export interface RestBook {
  bookId: string;
  bookName: string;
  author: string;
  isbn?: string;
  description?: string;
  genre?: string;
  year?: number;
  coverUrl?: string;
  price: number;
  stock: number;
  available: number;
  isDeleted: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BookList {
  books: RestBook[];
  total: number;
}

export interface EnrichedCartItem {
  bookId: string;
  amount: number;
  bookName?: string;
  author?: string;
  price?: number;
  /** catalog `available`, or `false` when the book is gone (spec 05 §2). */
  available: number | false;
}

export interface EnrichedCart {
  items: EnrichedCartItem[];
  expiresAt?: string;
}

export type OrderStatus = "PENDING" | "PAID" | "CANCELLED" | string;

export interface RestOrderItem {
  bookId: string;
  bookName: string;
  author: string;
  price: number;
  amount: number;
}

export interface RestOrder {
  orderId: string;
  userId: string;
  items: RestOrderItem[];
  totalPrice: number;
  status: OrderStatus;
  createdAt?: string;
  paidAt?: string;
  cancelledAt?: string;
}

export interface OrderList {
  orders: RestOrder[];
  total: number;
}

/** Unified gateway error format (spec 05 §6). */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  error?: string;
}
