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

// Optional employer seed (spec 06): no defaults — only when the name is set.
const employerName = process.env.SEED_EMPLOYER_USER_NAME;
if (employerName) {
  const employerPassword = process.env.SEED_EMPLOYER_PASSWORD;
  if (!employerPassword) {
    throw new Error(
      "SEED_EMPLOYER_PASSWORD is required when SEED_EMPLOYER_USER_NAME is set"
    );
  }
  const employerHash = await hashPassword(employerPassword);
  await prisma.user.upsert({
    where: { userName: employerName },
    update: {},
    create: {
      userName: employerName,
      passwordHash: employerHash,
      role: "EMPLOYER"
    }
  });
}

await prisma.$disconnect();
