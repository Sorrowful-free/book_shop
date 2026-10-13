import "reflect-metadata";
import { describe, expect, it, mock } from "bun:test";
import type { PrismaClient } from "./generated/prisma";
import { seedAdminUser, seedEmployerUser } from "./app.module";

// seedAdmin must NOT compute a hash when the admin already exists (fixes
// spec F-A2). The hash function is injected into seedAdminUser so this
// stays a plain spy — a global mock.module("./password") would leak into
// other test files sharing the process and break e2e logins/password
// checks.
function makePrisma(existingAdmin: unknown | null) {
  const userTable = {
    findUnique: mock(async (_args: unknown) => existingAdmin),
    upsert: mock(async (_args: unknown) => ({}))
  };
  const prisma = { user: userTable };
  return prisma as unknown as Pick<PrismaClient, "user"> & typeof prisma;
}

const hashPasswordSpy = () =>
  mock(async (password: string) => `argon2id:${password}`);

describe("seedAdminUser — lazy hashing (F-A2)", () => {
  it("does not hash the password when the admin already exists", async () => {
    const prisma = makePrisma({ id: "admin-1", userName: "admin" });
    const hash = hashPasswordSpy();

    await seedAdminUser(prisma, { userName: "admin", password: "admin", hash });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { userName: "admin" }
    });
    expect(hash).not.toHaveBeenCalled();
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("hashes the password and creates the admin when missing", async () => {
    const prisma = makePrisma(null);
    const hash = hashPasswordSpy();

    await seedAdminUser(prisma, { userName: "admin", password: "admin", hash });

    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledWith("admin");
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { userName: "admin" },
      update: {},
      create: {
        userName: "admin",
        passwordHash: "argon2id:admin",
        role: "ADMIN"
      }
    });
  });
});

// The optional employer seed (spec 06) shares the lazy-hashing semantics —
// covered with the same injected-hash fakes, no module mocks.
describe("seedEmployerUser — optional employer seed", () => {
  it("does not hash the password when the employer already exists", async () => {
    const prisma = makePrisma({ id: "emp-1", userName: "employer" });
    const hash = hashPasswordSpy();

    await seedEmployerUser(prisma, {
      userName: "employer",
      password: "s3cret",
      hash
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { userName: "employer" }
    });
    expect(hash).not.toHaveBeenCalled();
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("creates the user with role EMPLOYER when missing", async () => {
    const prisma = makePrisma(null);
    const hash = hashPasswordSpy();

    await seedEmployerUser(prisma, {
      userName: "employer",
      password: "s3cret",
      hash
    });

    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledWith("s3cret");
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { userName: "employer" },
      update: {},
      create: {
        userName: "employer",
        passwordHash: "argon2id:s3cret",
        role: "EMPLOYER"
      }
    });
  });
});
