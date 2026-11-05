import { prisma } from '../lib/db/prisma';
import { syncAllPlans } from '../lib/services/billing';

/**
 * Mirrors every Stripe product with `plan=true` metadata, and its recurring
 * prices, into Plan / PlanPrice. Run once after creating the products, and
 * again if webhooks were missed. Safe to re-run.
 */
const main = async (): Promise<void> => {
  const { plans, prices } = await syncAllPlans();
  console.log(`Synced ${plans} plan(s) and ${prices} price(s) from Stripe`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
