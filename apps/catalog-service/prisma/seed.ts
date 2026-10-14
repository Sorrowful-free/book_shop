// Demo seed for catalog_db (specs §3 + 08 §7): ~28 real books across every
// storefront genre, each with an Open Library cover URL.
//
// Idempotent — upserts by isbn so `bun run db:seed` can re-run:
// - new books are created with their coverUrl;
// - existing rows keep admin-edited data; a second pass fills coverUrl ONLY
//   where it is still NULL, so admin-uploaded covers (MinIO paths) are never
//   clobbered by a re-seed.
//
// Cover URLs point at covers.openlibrary.org by ISBN — the storefront links
// out instead of hosting images (no binaries in the repo). `?default=false`
// makes OL answer 404 for a missing cover, and the web layer's @error
// handler degrades to the placeholder. Every coverIsbn below was verified
// to resolve to a real cover (HTTP 200, tens of KB).

import "dotenv/config";
import { PrismaClient, Prisma } from "../src/generated/prisma";

const prisma = new PrismaClient();

const olCover = (coverIsbn: string): string =>
  `https://covers.openlibrary.org/b/isbn/${coverIsbn}-L.jpg?default=false`;

const BOOKS = [
  // --- fantasy ---
  {
    bookName: "The Hobbit",
    author: "J. R. R. Tolkien",
    isbn: "978-0-618-00221-3",
    description: "A fantasy prelude to The Lord of the Rings.",
    genre: "fantasy",
    year: 1937,
    price: "12.50",
    stock: 12,
    // this edition has no OL cover — use the HMH edition's cover
    coverIsbn: "9780395177112"
  },
  {
    bookName: "The Fellowship of the Ring",
    author: "J. R. R. Tolkien",
    isbn: "978-0-547-92821-0",
    description: "The Lord of the Rings, part one.",
    genre: "fantasy",
    year: 1954,
    price: "13.99",
    stock: 9
  },
  {
    bookName: "A Game of Thrones",
    author: "George R. R. Martin",
    isbn: "978-0-553-59371-6",
    description: "A Song of Ice and Fire, book one.",
    genre: "fantasy",
    year: 1996,
    price: "14.99",
    stock: 11
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
    bookName: "The Wise Man's Fear",
    author: "Patrick Rothfuss",
    isbn: "978-0-7564-0712-4",
    description: "The Kingkiller Chronicle, day two.",
    genre: "fantasy",
    year: 2011,
    price: "15.40",
    stock: 7
  },
  {
    bookName: "The Way of Kings",
    author: "Brandon Sanderson",
    isbn: "978-0-7653-7667-1",
    description: "The Stormlight Archive, book one.",
    genre: "fantasy",
    year: 2010,
    price: "17.90",
    stock: 6
  },
  // --- sci-fi ---
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
    bookName: "Foundation",
    author: "Isaac Asimov",
    isbn: "978-0-553-29335-7",
    description: "Psychohistory and the fall of a galactic empire.",
    genre: "sci-fi",
    year: 1951,
    price: "9.50",
    stock: 13
  },
  {
    bookName: "Ender's Game",
    author: "Orson Scott Card",
    isbn: "978-0-7653-4229-4",
    description: "A gifted child trains for an interstellar war.",
    genre: "sci-fi",
    year: 1985,
    price: "10.99",
    stock: 15
  },
  {
    bookName: "The Left Hand of Darkness",
    author: "Ursula K. Le Guin",
    isbn: "978-0-441-47812-5",
    description: "An envoy on a genderless world.",
    genre: "sci-fi",
    year: 1969,
    price: "10.25",
    stock: 5
  },
  {
    bookName: "Hyperion",
    author: "Dan Simmons",
    isbn: "978-0-553-28368-6",
    description: "Seven pilgrims, one Shrike.",
    genre: "sci-fi",
    year: 1989,
    price: "12.30",
    stock: 9
  },
  {
    bookName: "The Martian",
    author: "Andy Weir",
    isbn: "978-0-8041-3902-1",
    description: "Stranded botanist survives on Mars.",
    genre: "sci-fi",
    year: 2014,
    price: "11.99",
    stock: 17
  },
  // --- dystopia ---
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
    bookName: "Brave New World",
    author: "Aldous Huxley",
    isbn: "978-0-06-085052-4",
    description: "A society engineered for contentment.",
    genre: "dystopia",
    year: 1932,
    price: "10.50",
    stock: 14
  },
  {
    bookName: "Fahrenheit 451",
    author: "Ray Bradbury",
    isbn: "978-1-4516-7331-9",
    description: "A fireman who burns books begins to read them.",
    genre: "dystopia",
    year: 1953,
    price: "9.75",
    stock: 12
  },
  // --- tech ---
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
    bookName: "Design Patterns",
    author: "Erich Gamma",
    isbn: "978-0-201-63361-0",
    description: "Elements of reusable object-oriented software.",
    genre: "tech",
    year: 1994,
    price: "44.50",
    stock: 8
  },
  {
    bookName: "Structure and Interpretation of Computer Programs",
    author: "Harold Abelson",
    isbn: "978-0-262-51087-5",
    description: "The MIT Scheme classic (SICP).",
    genre: "tech",
    year: 1996,
    price: "49.99",
    stock: 4
  },
  {
    bookName: "The Mythical Man-Month",
    author: "Frederick P. Brooks Jr.",
    isbn: "978-0-201-83595-3",
    description: "Essays on software engineering.",
    genre: "tech",
    year: 1975,
    price: "29.95",
    stock: 6
  },
  // --- classic ---
  {
    bookName: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    isbn: "978-0-7432-7356-5",
    description: "Jazz Age tragedy on Long Island.",
    genre: "classic",
    year: 1925,
    price: "8.99",
    stock: 22
  },
  {
    bookName: "To Kill a Mockingbird",
    author: "Harper Lee",
    isbn: "978-0-06-093546-7",
    description: "Conscience and injustice in the American South.",
    genre: "classic",
    year: 1960,
    price: "9.25",
    stock: 16
  },
  {
    bookName: "Moby-Dick",
    author: "Herman Melville",
    isbn: "978-0-14-243724-7",
    description: "Ahab's obsessive hunt for the white whale.",
    genre: "classic",
    year: 1851,
    price: "12.75",
    stock: 7
  },
  // --- non-fiction ---
  {
    bookName: "Sapiens",
    author: "Yuval Noah Harari",
    isbn: "978-0-06-231609-7",
    description: "A brief history of humankind.",
    genre: "non-fiction",
    year: 2011,
    price: "18.75",
    stock: 14
  },
  {
    bookName: "A Brief History of Time",
    author: "Stephen Hawking",
    isbn: "978-0-553-38016-3",
    description: "Cosmology for the general reader.",
    genre: "non-fiction",
    year: 1988,
    price: "15.50",
    stock: 10
  },
  // --- mystery ---
  {
    bookName: "And Then There Were None",
    author: "Agatha Christie",
    isbn: "978-0-06-207348-8",
    description: "Ten strangers, one island, no survivors.",
    genre: "mystery",
    year: 1939,
    price: "9.99",
    stock: 18
  },
  // --- history ---
  {
    bookName: "1776",
    author: "David McCullough",
    isbn: "978-0-7432-2672-1",
    description: "The pivotal year of the American Revolution.",
    genre: "history",
    year: 2005,
    price: "16.00",
    stock: 8
  }
];

async function main(): Promise<void> {
  for (const book of BOOKS) {
    const coverUrl = olCover(book.coverIsbn ?? book.isbn.replaceAll("-", ""));
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
        coverUrl,
        price: new Prisma.Decimal(book.price),
        stock: book.stock
      }
    });
    // Re-seed fills a missing cover but never overwrites one — an
    // admin-uploaded cover (/api/v1/covers/<key>) survives `db:seed`.
    await prisma.book.updateMany({
      where: { isbn: book.isbn, coverUrl: null },
      data: { coverUrl }
    });
  }
  console.log(`Seeded ${BOOKS.length} demo books (covers via Open Library)`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
