import { describe, expect, it } from "bun:test";
import {
  authProto,
  cartProto,
  catalogProto,
  orderProto,
  UserRole
} from "@book-shop/contracts";
import {
  enrichCart,
  presentBook,
  presentOrder,
  presentUser
} from "./presenters";

function book(overrides: Partial<catalogProto.Book>): catalogProto.Book {
  return {
    bookId: "b-1",
    bookName: "Dune",
    author: "Herbert",
    price: 9.99,
    stock: 10,
    available: 7,
    isDeleted: false,
    createdAt: { seconds: 1_700_000_000, nanos: 0 },
    ...overrides
  };
}

describe("cart enrichment — BFF merge (spec §2/§9)", () => {
  it("merges positions with name/author/price/available", () => {
    const cart: cartProto.Cart = {
      items: [
        { bookId: "b-1", amount: 2 },
        { bookId: "b-2", amount: 1 }
      ],
      expiresAt: { seconds: 1_700_000_000, nanos: 0 }
    };
    const result = enrichCart(cart, [
      book({ bookId: "b-1" }),
      book({
        bookId: "b-2",
        bookName: "Foundation",
        author: "Asimov",
        price: 5
      })
    ]);
    expect(result.items).toEqual([
      {
        bookId: "b-1",
        amount: 2,
        bookName: "Dune",
        author: "Herbert",
        price: 9.99,
        available: 7
      },
      {
        bookId: "b-2",
        amount: 1,
        bookName: "Foundation",
        author: "Asimov",
        price: 5,
        available: 7
      }
    ]);
    expect(result.expiresAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("degrades missing books to available:false without metadata", () => {
    const cart: cartProto.Cart = {
      items: [
        { bookId: "b-1", amount: 2 },
        { bookId: "gone", amount: 3 }
      ]
    };
    const result = enrichCart(cart, [book({ bookId: "b-1" })]);
    expect(result.items[0].bookName).toBe("Dune");
    expect(result.items[1]).toEqual({
      bookId: "gone",
      amount: 3,
      available: false
    });
  });

  it("enriches nothing when the books list is empty", () => {
    const cart: cartProto.Cart = { items: [{ bookId: "x", amount: 1 }] };
    expect(enrichCart(cart, []).items).toEqual([
      { bookId: "x", amount: 1, available: false }
    ]);
  });
});

describe("proto → REST presentation", () => {
  it("presents books with ISO timestamps", () => {
    const out = presentBook(
      book({ updatedAt: { seconds: 1_700_000_500, nanos: 0 } })
    );
    expect(out.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(out.updatedAt).toBe(new Date(1_700_000_500_000).toISOString());
    expect(out.price).toBe(9.99);
  });

  it("maps proto user role enum to its name", () => {
    const out = presentUser({
      userId: "u-1",
      userName: "alice",
      role: authProto.Role.ROLE_EMPLOYER
    });
    expect(out).toEqual({
      userId: "u-1",
      userName: "alice",
      role: UserRole.Employer,
      createdAt: undefined
    });
  });

  it("maps order status enum to its name and drops empty timestamps", () => {
    const order = presentOrder({
      orderId: "o-1",
      userId: "u-1",
      items: [],
      totalPrice: 42,
      status: orderProto.OrderStatus.ORDER_STATUS_PAID,
      createdAt: { seconds: 1_700_000_000, nanos: 0 },
      paidAt: { seconds: 1_700_000_100, nanos: 0 }
    });
    expect(order.status).toBe("PAID");
    expect(order.paidAt).toBe(new Date(1_700_000_100_000).toISOString());
    expect(order.cancelledAt).toBeUndefined();
  });
});
