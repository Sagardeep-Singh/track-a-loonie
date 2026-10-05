import bcrypt from 'bcryptjs';
import { prisma } from '../lib/db/prisma';
import { provisionDefaultsForUser } from '../lib/services/defaults';
import { normalizeEmail } from '../lib/validators/email';

const main = async (): Promise<void> => {
  const rawEmail = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!rawEmail || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  }
  const email = normalizeEmail(rawEmail);

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findUnique({ where: { email } });

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash },
  });

  if (!existing) {
    await provisionDefaultsForUser(user.id);
  }

  console.log(`Admin user ready: ${user.email}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
