// Demo seed for catalog_db (spec §3): a handful of books across genres with
// stock > 0. Idempotent — upserts by isbn so `bun run db:seed` can re-run.

import "dotenv/config";
import { PrismaClient, Prisma } from "../src/generated/prisma";

const prisma = new PrismaClient();

const BOOKS = [
  {
    bookName: "The Hobbit",
    author: "J. R. R. Tolkien",
    isbn: "978-0-618-00221-3",
    description: "A fantasy prelude to The Lord of the Rings.",
    genre: "fantasy",
    year: 1937,
    price: "12.50",
    stock: 12
  },
  {
    bookName: "Dune",
    author: "Frank Herbert",
    isbn: "978-0-441-17271-9",
    description: "Epic science-fiction saga on Arrakis.",
    genre: "sci-fi",
    year: 1965,
    price: "15.99",
    stock: 8
  },
  {
    bookName: "Clean Code",
    author: "Robert C. Martin",
    isbn: "978-0-13-235088-4",
    description: "A handbook of agile software craftsmanship.",
    genre: "tech",
    year: 2008,
    price: "34.90",
    stock: 20
  },
  {
    bookName: "The Pragmatic Programmer",
    author: "David Thomas",
    isbn: "978-0-13-595705-9",
    description: "Your journey to mastery, 20th anniversary edition.",
    genre: "tech",
    year: 2019,
    price: "39.95",
    stock: 15
  },
  {
    bookName: "1984",
    author: "George Orwell",
    isbn: "978-0-452-28423-4",
    description: "Dystopian classic about surveillance and control.",
    genre: "dystopia",
    year: 1949,
    price: "9.99",
    stock: 25
  },
  {
    bookName: "The Name of the Wind",
    author: "Patrick Rothfuss",
    isbn: "978-0-7564-0474-1",
    description: "The Kingkiller Chronicle, day one.",
    genre: "fantasy",
    year: 2007,
    price: "14.20",
    stock: 10
  },
  {
    bookName: "Neuromancer",
    author: "William Gibson",
    isbn: "978-0-441-56959-5",
    description: "Cyberpunk founding novel.",
    genre: "sci-fi",
    year: 1984,
    price: "11.40",
    stock: 6
  },
  {
    bookName: "Sapiens",
    author: "Yuval Noah Harari",
    isbn: "978-0-06-231609-7",
    description: "A brief history of humankind.",
    genre: "non-fiction",
    year: 2011,
    price: "18.75",
    stock: 14
  }
];

async function main(): Promise<void> {
  for (const book of BOOKS) {
    await prisma.book.upsert({
      where: { isbn: book.isbn },
      update: {},
      create: {
        bookName: book.bookName,
        author: book.author,
        isbn: book.isbn,
        description: book.description,
        genre: book.genre,
        year: book.year,
        price: new Prisma.Decimal(book.price),
        stock: book.stock
      }
    });
  }
  console.log(`Seeded ${BOOKS.length} demo books`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
