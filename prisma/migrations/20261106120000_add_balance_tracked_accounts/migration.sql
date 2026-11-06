-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "tracksBalance" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AccountBalanceUpdate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountBalanceUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountBalanceUpdate_accountId_date_idx" ON "AccountBalanceUpdate"("accountId", "date");

-- CreateIndex
CREATE INDEX "AccountBalanceUpdate_userId_idx" ON "AccountBalanceUpdate"("userId");

-- AddForeignKey
ALTER TABLE "AccountBalanceUpdate" ADD CONSTRAINT "AccountBalanceUpdate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBalanceUpdate" ADD CONSTRAINT "AccountBalanceUpdate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
