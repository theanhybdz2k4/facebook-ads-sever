-- AlterTable
ALTER TABLE "unified_ad_groups" ADD COLUMN     "effective_status" TEXT;

-- AlterTable
ALTER TABLE "unified_ads" ADD COLUMN     "effective_status" TEXT;

-- AlterTable
ALTER TABLE "unified_campaigns" ADD COLUMN     "effective_status" TEXT;
