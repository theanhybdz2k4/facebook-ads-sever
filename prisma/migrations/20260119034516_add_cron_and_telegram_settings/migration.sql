-- DropForeignKey
ALTER TABLE "platform_accounts" DROP CONSTRAINT "platform_accounts_platform_id_fkey";

-- DropForeignKey
ALTER TABLE "platform_accounts" DROP CONSTRAINT "platform_accounts_platform_identity_id_fkey";

-- DropForeignKey
ALTER TABLE "platform_identities" DROP CONSTRAINT "platform_identities_platform_id_fkey";

-- DropForeignKey
ALTER TABLE "platform_identities" DROP CONSTRAINT "platform_identities_user_id_fkey";

-- DropForeignKey
ALTER TABLE "sync_jobs" DROP CONSTRAINT "sync_jobs_platform_account_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_ad_groups" DROP CONSTRAINT "unified_ad_groups_unified_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_ads" DROP CONSTRAINT "unified_ads_unified_ad_group_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_campaigns" DROP CONSTRAINT "unified_campaigns_platform_account_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_insights" DROP CONSTRAINT "unified_insights_platform_account_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_insights" DROP CONSTRAINT "unified_insights_unified_ad_group_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_insights" DROP CONSTRAINT "unified_insights_unified_ad_id_fkey";

-- DropForeignKey
ALTER TABLE "unified_insights" DROP CONSTRAINT "unified_insights_unified_campaign_id_fkey";

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "platform_accounts" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "platform_credentials" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "platform_identities" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sync_jobs" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "unified_ad_groups" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "optimization_goal" TEXT;

-- AlterTable
ALTER TABLE "unified_ads" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "unified_campaigns" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "unified_insights" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "unified_hourly_insights" (
    "id" TEXT NOT NULL,
    "platform_account_id" INTEGER NOT NULL,
    "unified_campaign_id" TEXT,
    "unified_ad_group_id" TEXT,
    "unified_ad_id" TEXT,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "spend" DECIMAL(20,4),
    "impressions" BIGINT,
    "clicks" BIGINT,
    "results" BIGINT,
    "platform_metrics" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "unified_hourly_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_settings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "cron_type" TEXT NOT NULL,
    "allowed_hours" INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_bot_settings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "telegram_bot_token" TEXT,
    "telegram_chat_id" TEXT,
    "noti_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_bot_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "unified_hourly_insights_platform_account_id_date_hour_idx" ON "unified_hourly_insights"("platform_account_id", "date", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "unified_hourly_insights_platform_account_id_unified_campaig_key" ON "unified_hourly_insights"("platform_account_id", "unified_campaign_id", "unified_ad_group_id", "unified_ad_id", "date", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "cron_settings_user_id_cron_type_key" ON "cron_settings"("user_id", "cron_type");

-- CreateIndex
CREATE UNIQUE INDEX "user_bot_settings_user_id_key" ON "user_bot_settings"("user_id");

-- AddForeignKey
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_platform_identity_id_fkey" FOREIGN KEY ("platform_identity_id") REFERENCES "platform_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_campaigns" ADD CONSTRAINT "unified_campaigns_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_ad_groups" ADD CONSTRAINT "unified_ad_groups_unified_campaign_id_fkey" FOREIGN KEY ("unified_campaign_id") REFERENCES "unified_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_ad_groups" ADD CONSTRAINT "unified_ad_groups_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_ads" ADD CONSTRAINT "unified_ads_unified_ad_group_id_fkey" FOREIGN KEY ("unified_ad_group_id") REFERENCES "unified_ad_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_ads" ADD CONSTRAINT "unified_ads_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_unified_campaign_id_fkey" FOREIGN KEY ("unified_campaign_id") REFERENCES "unified_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_unified_ad_group_id_fkey" FOREIGN KEY ("unified_ad_group_id") REFERENCES "unified_ad_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_unified_ad_id_fkey" FOREIGN KEY ("unified_ad_id") REFERENCES "unified_ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_hourly_insights" ADD CONSTRAINT "unified_hourly_insights_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_hourly_insights" ADD CONSTRAINT "unified_hourly_insights_unified_campaign_id_fkey" FOREIGN KEY ("unified_campaign_id") REFERENCES "unified_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_hourly_insights" ADD CONSTRAINT "unified_hourly_insights_unified_ad_group_id_fkey" FOREIGN KEY ("unified_ad_group_id") REFERENCES "unified_ad_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_hourly_insights" ADD CONSTRAINT "unified_hourly_insights_unified_ad_id_fkey" FOREIGN KEY ("unified_ad_id") REFERENCES "unified_ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cron_settings" ADD CONSTRAINT "cron_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_bot_settings" ADD CONSTRAINT "user_bot_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
