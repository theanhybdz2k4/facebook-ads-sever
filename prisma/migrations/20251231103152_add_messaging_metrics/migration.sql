-- AlterTable
ALTER TABLE "ad_insights_daily" ADD COLUMN     "cost_per_messaging" DECIMAL(20,4),
ADD COLUMN     "cost_per_result" DECIMAL(20,4),
ADD COLUMN     "messaging_started" BIGINT,
ADD COLUMN     "results" BIGINT;

-- AlterTable
ALTER TABLE "ad_insights_hourly" ADD COLUMN     "cost_per_messaging" DECIMAL(20,4),
ADD COLUMN     "cost_per_result" DECIMAL(20,4),
ADD COLUMN     "messaging_started" BIGINT,
ADD COLUMN     "results" BIGINT;
