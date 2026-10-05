-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "spreadEndMonth" INTEGER,
ADD COLUMN     "spreadMonths" INTEGER,
ADD COLUMN     "spreadStartMonth" INTEGER;

-- CreateIndex
CREATE INDEX "Transaction_userId_spreadEndMonth_idx" ON "Transaction"("userId", "spreadEndMonth");
