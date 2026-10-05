-- CreateEnum
CREATE TYPE "BudgetMode" AS ENUM ('LIMITS', 'ZERO_BASED');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "onBudget" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "UserBudgetSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "BudgetMode" NOT NULL DEFAULT 'LIMITS',
    "zbbStartMonth" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBudgetSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserBudgetSettings_userId_key" ON "UserBudgetSettings"("userId");

-- CreateIndex
CREATE INDEX "CategoryAssignment_userId_month_idx" ON "CategoryAssignment"("userId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryAssignment_userId_categoryId_month_key" ON "CategoryAssignment"("userId", "categoryId", "month");

-- AddForeignKey
ALTER TABLE "UserBudgetSettings" ADD CONSTRAINT "UserBudgetSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAssignment" ADD CONSTRAINT "CategoryAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAssignment" ADD CONSTRAINT "CategoryAssignment_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Savings is off-budget by default in zero-based mode
UPDATE "Account" SET "onBudget" = false WHERE "type" = 'SAVINGS';
