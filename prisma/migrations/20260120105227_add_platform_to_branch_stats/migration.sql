/*
  Warnings:

  - A unique constraint covering the columns `[branch_id,date,platform_code]` on the table `branch_daily_stats` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "branch_daily_stats_branch_id_date_key";

-- AlterTable
ALTER TABLE "branch_daily_stats" ADD COLUMN     "platform_code" TEXT NOT NULL DEFAULT 'all';

-- CreateIndex
CREATE UNIQUE INDEX "branch_daily_stats_branch_id_date_platform_code_key" ON "branch_daily_stats"("branch_id", "date", "platform_code");
