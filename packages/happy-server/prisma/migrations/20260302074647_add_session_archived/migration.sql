-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Session_accountId_archived_idx" ON "Session"("accountId", "archived");
