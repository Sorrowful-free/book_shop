/**
 * prisma seed — creates the admin user from SEED_ADMIN_* env (defaults
 * admin/admin, spec §3). Idempotent upsert; the app module seeds the same
 * way at startup, so this mostly matters for `prisma migrate dev`.
 */
import { PrismaClient } from "../src/generated/prisma";
import { hashPassword } from "../src/password";

const prisma = new PrismaClient();

const userName = process.env.SEED_ADMIN_USER_NAME ?? "admin";
const password = process.env.SEED_ADMIN_PASSWORD ?? "admin";
const passwordHash = await hashPassword(password);

await prisma.user.upsert({
  where: { userName },
  update: {},
  create: { userName, passwordHash, role: "ADMIN" }
});

await prisma.$disconnect();
