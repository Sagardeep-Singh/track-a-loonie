import bcrypt from 'bcryptjs';
import { prisma } from '../lib/db/prisma';
import { provisionDefaultsForUser } from '../lib/services/defaults';
import { normalizeEmail } from '../lib/validators/email';

const main = async (): Promise<void> => {
  const email = normalizeEmail(process.env.ADMIN_EMAIL ?? 'dev@example.com');
  const password = process.env.ADMIN_PASSWORD ?? 'devpassword123';

  // destructive: local dev only, never run against production
  await prisma.reimbursementLink.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.categoryRule.deleteMany();
  await prisma.budget.deleteMany();
  await prisma.category.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({ data: { email, passwordHash, name: 'Dev' } });

  await provisionDefaultsForUser(user.id);

  console.log(`Seeded user ${user.email} with default categories, category rules, and account`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
