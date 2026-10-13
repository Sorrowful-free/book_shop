// Proto → REST presentation (BFF): timestamps become ISO strings and enums
// become their proto names — a JSON API shouldn't leak `{seconds,nanos}`
// blobs or bare enum ints to clients.

import {
  authProto,
  cartProto,
  catalogProto,
  orderProto,
  UserRole
} from "@book-shop/contracts";
import type { Timestamp } from "@book-shop/contracts/gen/google/protobuf/timestamp";

function iso(timestamp: Timestamp | undefined): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  return new Date(
    timestamp.seconds * 1000 + timestamp.nanos / 1e6
  ).toISOString();
}

// ---------------------------------------------------------------------------
// books (catalog)
// ---------------------------------------------------------------------------

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

export function presentBook(book: catalogProto.Book): RestBook {
  return {
    ...book,
    createdAt: iso(book.createdAt),
    updatedAt: iso(book.updatedAt)
  };
}

// ---------------------------------------------------------------------------
// users (auth) — proto enum Role → its wire name ("ADMIN" etc.)
// ---------------------------------------------------------------------------

const AUTH_ROLE_NAMES: Record<number, UserRole> = {
  [authProto.Role.ROLE_ADMIN]: UserRole.Admin,
  [authProto.Role.ROLE_EMPLOYER]: UserRole.Employer,
  [authProto.Role.ROLE_CUSTOMER]: UserRole.Customer
};

export interface RestUser {
  userId: string;
  userName: string;
  role: UserRole;
  createdAt?: string;
}

export function presentUser(user: authProto.User): RestUser {
  return {
    userId: user.userId,
    userName: user.userName,
    role: AUTH_ROLE_NAMES[user.role] ?? UserRole.None,
    createdAt: iso(user.createdAt)
  };
}

// ---------------------------------------------------------------------------
// cart — raw positions enriched with catalog data (spec §2 BFF aggregation)
// ---------------------------------------------------------------------------

export interface EnrichedCartItem {
  bookId: string;
  amount: number;
  bookName?: string;
  author?: string;
  price?: number;
  /**
   * catalog `available` (stock − active reservations) for known books;
   * `false` for positions whose book is gone — spec §2 degradation.
   */
  available: number | false;
}

export interface EnrichedCart {
  items: EnrichedCartItem[];
  expiresAt?: string;
}

/**
 * Merge cart positions with catalog books. A book absent from `books` —
 * deleted or never existing — yields a metadata-less position with
 * `available: false` instead of failing the whole response.
 */
export function enrichCart(
  cart: cartProto.Cart,
  books: catalogProto.Book[]
): EnrichedCart {
  const byId = new Map(books.map((book) => [book.bookId, book]));
  return {
    items: cart.items.map((item) => {
      const book = byId.get(item.bookId);
      if (!book) {
        return { bookId: item.bookId, amount: item.amount, available: false };
      }
      return {
        bookId: item.bookId,
        amount: item.amount,
        bookName: book.bookName,
        author: book.author,
        price: book.price,
        available: book.available
      };
    }),
    expiresAt: iso(cart.expiresAt)
  };
}

// ---------------------------------------------------------------------------
// orders — proto enum OrderStatus → its name ("PENDING" etc.)
// ---------------------------------------------------------------------------

const ORDER_STATUS_NAMES: Record<number, string> = {
  [orderProto.OrderStatus.ORDER_STATUS_PENDING]: "PENDING",
  [orderProto.OrderStatus.ORDER_STATUS_PAID]: "PAID",
  [orderProto.OrderStatus.ORDER_STATUS_CANCELLED]: "CANCELLED"
};

export interface RestOrder {
  orderId: string;
  userId: string;
  items: orderProto.OrderItem[];
  totalPrice: number;
  status: string;
  createdAt?: string;
  paidAt?: string;
  cancelledAt?: string;
}

export function presentOrder(order: orderProto.Order): RestOrder {
  return {
    ...order,
    status: ORDER_STATUS_NAMES[order.status] ?? "UNSPECIFIED",
    createdAt: iso(order.createdAt),
    paidAt: iso(order.paidAt),
    cancelledAt: iso(order.cancelledAt)
  };
}
