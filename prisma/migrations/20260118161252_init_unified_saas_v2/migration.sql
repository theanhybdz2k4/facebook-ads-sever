/*
  Warnings:

  - You are about to drop the column `ad_account_count` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `ads_count` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `total_clicks` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `total_impressions` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `total_messaging` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `total_reach` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `total_results` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `total_spend` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `branch_daily_stats` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `branches` table. All the data in the column will be lost.
  - You are about to drop the column `is_active` on the `platform_accounts` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `platforms` table. All the data in the column will be lost.
  - You are about to drop the column `deleted_at` on the `refresh_tokens` table. All the data in the column will be lost.
  - You are about to drop the column `bid_amount` on the `unified_ad_groups` table. All the data in the column will be lost.
  - You are about to drop the column `platform_id` on the `unified_ad_groups` table. All the data in the column will be lost.
  - You are about to drop the column `targeting` on the `unified_ad_groups` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `unified_ad_groups` table. All the data in the column will be lost.
  - The `status` column on the `unified_ad_groups` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `creative_id` on the `unified_ads` table. All the data in the column will be lost.
  - You are about to drop the column `platform_id` on the `unified_ads` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `unified_ads` table. All the data in the column will be lost.
  - The `status` column on the `unified_ads` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `currency` on the `unified_campaigns` table. All the data in the column will be lost.
  - You are about to drop the column `platform_id` on the `unified_campaigns` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `unified_campaigns` table. All the data in the column will be lost.
  - The `status` column on the `unified_campaigns` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `cpc` on the `unified_insights` table. All the data in the column will be lost.
  - You are about to drop the column `cpm` on the `unified_insights` table. All the data in the column will be lost.
  - You are about to drop the column `ctr` on the `unified_insights` table. All the data in the column will be lost.
  - You are about to drop the column `entity_id` on the `unified_insights` table. All the data in the column will be lost.
  - You are about to drop the column `entity_type` on the `unified_insights` table. All the data in the column will be lost.
  - You are about to drop the column `platform_id` on the `unified_insights` table. All the data in the column will be lost.
  - You are about to drop the column `deleted_at` on the `users` table. All the data in the column will be lost.
  - You are about to drop the `ad_accounts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_images` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_insights_age_gender_daily` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_insights_daily` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_insights_device_daily` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_insights_hourly` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_insights_placement_daily` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_insights_region_daily` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ad_videos` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ads` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `adsets` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `campaigns` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `crawl_jobs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `creatives` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `fb_accounts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `fb_api_tokens` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `telegram_bot_subscribers` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_ad_accounts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_cron_settings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_telegram_bot_settings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_telegram_bots` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[platform_account_id,external_id]` on the table `unified_ad_groups` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[platform_account_id,external_id]` on the table `unified_ads` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[platform_account_id,external_id]` on the table `unified_campaigns` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[platform_account_id,unified_campaign_id,unified_ad_group_id,unified_ad_id,date]` on the table `unified_insights` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "UnifiedStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- DropForeignKey
ALTER TABLE "ad_accounts" DROP CONSTRAINT "ad_accounts_branch_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_accounts" DROP CONSTRAINT "ad_accounts_fb_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_images" DROP CONSTRAINT "ad_images_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_age_gender_daily" DROP CONSTRAINT "ad_insights_age_gender_daily_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_age_gender_daily" DROP CONSTRAINT "ad_insights_age_gender_daily_ad_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_daily" DROP CONSTRAINT "ad_insights_daily_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_daily" DROP CONSTRAINT "ad_insights_daily_ad_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_device_daily" DROP CONSTRAINT "ad_insights_device_daily_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_device_daily" DROP CONSTRAINT "ad_insights_device_daily_ad_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_hourly" DROP CONSTRAINT "ad_insights_hourly_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_hourly" DROP CONSTRAINT "ad_insights_hourly_ad_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_placement_daily" DROP CONSTRAINT "ad_insights_placement_daily_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_placement_daily" DROP CONSTRAINT "ad_insights_placement_daily_ad_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_region_daily" DROP CONSTRAINT "ad_insights_region_daily_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_insights_region_daily" DROP CONSTRAINT "ad_insights_region_daily_ad_id_fkey";

-- DropForeignKey
ALTER TABLE "ad_videos" DROP CONSTRAINT "ad_videos_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ads" DROP CONSTRAINT "ads_account_id_fkey";

-- DropForeignKey
ALTER TABLE "ads" DROP CONSTRAINT "ads_adset_id_fkey";

-- DropForeignKey
ALTER TABLE "ads" DROP CONSTRAINT "ads_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "ads" DROP CONSTRAINT "ads_creative_id_fkey";

-- DropForeignKey
ALTER TABLE "adsets" DROP CONSTRAINT "adsets_account_id_fkey";

-- DropForeignKey
ALTER TABLE "adsets" DROP CONSTRAINT "adsets_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_account_id_fkey";

-- DropForeignKey
ALTER TABLE "crawl_jobs" DROP CONSTRAINT "crawl_jobs_account_id_fkey";

-- DropForeignKey
ALTER TABLE "creatives" DROP CONSTRAINT "creatives_account_id_fkey";

-- DropForeignKey
ALTER TABLE "creatives" DROP CONSTRAINT "creatives_image_hash_fkey";

-- DropForeignKey
ALTER TABLE "creatives" DROP CONSTRAINT "creatives_video_id_fkey";

-- DropForeignKey
ALTER TABLE "fb_accounts" DROP CONSTRAINT "fb_accounts_user_id_fkey";

-- DropForeignKey
ALTER TABLE "fb_api_tokens" DROP CONSTRAINT "fb_api_tokens_fb_account_id_fkey";

-- DropForeignKey
ALTER TABLE "telegram_bot_subscribers" DROP CONSTRAINT "telegram_bot_subscribers_bot_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_campaigns" DROP CONSTRAINT "unified_campaigns_platform_id_fkey";

-- DropForeignKey
ALTER TABLE "user_ad_accounts" DROP CONSTRAINT "user_ad_accounts_ad_account_id_fkey";

-- DropForeignKey
ALTER TABLE "user_ad_accounts" DROP CONSTRAINT "user_ad_accounts_user_id_fkey";

-- DropForeignKey
ALTER TABLE "user_cron_settings" DROP CONSTRAINT "user_cron_settings_user_id_fkey";

-- DropForeignKey
ALTER TABLE "user_telegram_bot_settings" DROP CONSTRAINT "user_telegram_bot_settings_bot_id_fkey";

-- DropForeignKey
ALTER TABLE "user_telegram_bot_settings" DROP CONSTRAINT "user_telegram_bot_settings_user_id_fkey";

-- DropForeignKey
ALTER TABLE "user_telegram_bots" DROP CONSTRAINT "user_telegram_bots_ad_account_id_fkey";

-- DropForeignKey
ALTER TABLE "user_telegram_bots" DROP CONSTRAINT "user_telegram_bots_user_id_fkey";

-- DropIndex
DROP INDEX "branch_daily_stats_branch_id_date_idx";

-- DropIndex
DROP INDEX "branches_user_id_idx";

-- DropIndex
DROP INDEX "unified_ad_groups_platform_id_external_id_key";

-- DropIndex
DROP INDEX "unified_ads_platform_id_external_id_key";

-- DropIndex
DROP INDEX "unified_campaigns_platform_id_external_id_key";

-- DropIndex
DROP INDEX "unified_insights_date_idx";

-- DropIndex
DROP INDEX "unified_insights_entity_type_entity_id_platform_id_date_key";

-- AlterTable
ALTER TABLE "branch_daily_stats" DROP COLUMN "ad_account_count",
DROP COLUMN "ads_count",
DROP COLUMN "created_at",
DROP COLUMN "total_clicks",
DROP COLUMN "total_impressions",
DROP COLUMN "total_messaging",
DROP COLUMN "total_reach",
DROP COLUMN "total_results",
DROP COLUMN "total_spend",
DROP COLUMN "updated_at",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "totalImpressions" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalResults" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalSpend" DECIMAL(20,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "branches" DROP COLUMN "updated_at";

-- AlterTable
ALTER TABLE "platform_accounts" DROP COLUMN "is_active",
ADD COLUMN     "branch_id" INTEGER,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "synced_at" DROP NOT NULL;

-- AlterTable
ALTER TABLE "platforms" DROP COLUMN "isActive",
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "refresh_tokens" DROP COLUMN "deleted_at";

-- AlterTable
ALTER TABLE "unified_ad_groups" DROP COLUMN "bid_amount",
DROP COLUMN "platform_id",
DROP COLUMN "targeting",
DROP COLUMN "updated_at",
DROP COLUMN "status",
ADD COLUMN     "status" "UnifiedStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "unified_ads" DROP COLUMN "creative_id",
DROP COLUMN "platform_id",
DROP COLUMN "updated_at",
ADD COLUMN     "creative_data" JSONB,
DROP COLUMN "status",
ADD COLUMN     "status" "UnifiedStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "unified_campaigns" DROP COLUMN "currency",
DROP COLUMN "platform_id",
DROP COLUMN "updated_at",
DROP COLUMN "status",
ADD COLUMN     "status" "UnifiedStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "unified_insights" DROP COLUMN "cpc",
DROP COLUMN "cpm",
DROP COLUMN "ctr",
DROP COLUMN "entity_id",
DROP COLUMN "entity_type",
DROP COLUMN "platform_id",
ADD COLUMN     "reach" BIGINT,
ADD COLUMN     "unified_ad_group_id" TEXT,
ADD COLUMN     "unified_campaign_id" TEXT;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "deleted_at";

-- DropTable
DROP TABLE "ad_accounts";

-- DropTable
DROP TABLE "ad_images";

-- DropTable
DROP TABLE "ad_insights_age_gender_daily";

-- DropTable
DROP TABLE "ad_insights_daily";

-- DropTable
DROP TABLE "ad_insights_device_daily";

-- DropTable
DROP TABLE "ad_insights_hourly";

-- DropTable
DROP TABLE "ad_insights_placement_daily";

-- DropTable
DROP TABLE "ad_insights_region_daily";

-- DropTable
DROP TABLE "ad_videos";

-- DropTable
DROP TABLE "ads";

-- DropTable
DROP TABLE "adsets";

-- DropTable
DROP TABLE "campaigns";

-- DropTable
DROP TABLE "crawl_jobs";

-- DropTable
DROP TABLE "creatives";

-- DropTable
DROP TABLE "fb_accounts";

-- DropTable
DROP TABLE "fb_api_tokens";

-- DropTable
DROP TABLE "telegram_bot_subscribers";

-- DropTable
DROP TABLE "user_ad_accounts";

-- DropTable
DROP TABLE "user_cron_settings";

-- DropTable
DROP TABLE "user_telegram_bot_settings";

-- DropTable
DROP TABLE "user_telegram_bots";

-- DropEnum
DROP TYPE "CrawlJobStatus";

-- DropEnum
DROP TYPE "CrawlJobType";

-- DropEnum
DROP TYPE "TokenType";

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" SERIAL NOT NULL,
    "platform_account_id" INTEGER NOT NULL,
    "job_type" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_accounts_branch_id_idx" ON "platform_accounts"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_ad_groups_platform_account_id_external_id_key" ON "unified_ad_groups"("platform_account_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_ads_platform_account_id_external_id_key" ON "unified_ads"("platform_account_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_campaigns_platform_account_id_external_id_key" ON "unified_campaigns"("platform_account_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_insights_platform_account_id_unified_campaign_id_un_key" ON "unified_insights"("platform_account_id", "unified_campaign_id", "unified_ad_group_id", "unified_ad_id", "date");

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_unified_campaign_id_fkey" FOREIGN KEY ("unified_campaign_id") REFERENCES "unified_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_unified_ad_group_id_fkey" FOREIGN KEY ("unified_ad_group_id") REFERENCES "unified_ad_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
