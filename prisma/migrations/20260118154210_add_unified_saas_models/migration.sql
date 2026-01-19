/*
  Warnings:

  - You are about to drop the column `action_values` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `canvas_avg_view_percent` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `canvas_avg_view_time` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `catalog_segment_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `catalog_segment_value` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `conversion_rate_ranking` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `conversion_values` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `conversions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_action_type` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_conversion` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_inline_link_click` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_outbound_click` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_action_type` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_click` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_inline_link_click` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_outbound_click` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `cpp` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `date_start` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `date_stop` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `engagement_rate_ranking` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `estimated_ad_recall_rate` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `estimated_ad_recallers` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `frequency` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `full_view_impressions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `full_view_reach` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `inline_link_click_ctr` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `inline_link_clicks` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `inline_post_engagement` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `instant_experience_clicks_to_open` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `instant_experience_clicks_to_start` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `instant_experience_outbound_clicks` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `mobile_app_purchase_roas` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `outbound_clicks` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `outbound_clicks_ctr` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `purchase_roas` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `quality_ranking` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `social_spend` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `unique_clicks` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `unique_ctr` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `unique_inline_link_clicks` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `unique_inline_post_engagement` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `unique_link_clicks_ctr` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `unique_outbound_clicks` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_30_sec_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_avg_time_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_continuous_2_sec_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_p100_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_p25_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_p50_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_p75_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_p95_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_play_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_play_curve_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_thruplay_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `video_time_watched_actions` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `website_purchase_roas` on the `ad_insights_daily` table. All the data in the column will be lost.
  - You are about to drop the column `action_values` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `action_values_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `actions_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `canvas_avg_view_percent` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `canvas_avg_view_time` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `catalog_segment_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `catalog_segment_value` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `clicks_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `conversion_rate_ranking` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `conversion_values` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `conversion_values_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `conversions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `conversions_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_action_type` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_conversion` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_inline_link_click` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_outbound_click` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_action_type` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_click` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_inline_link_click` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cost_per_unique_outbound_click` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cpc_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cpm_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `cpp` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `ctr_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `date_start` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `date_stop` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `engagement_rate_ranking` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `estimated_ad_recall_rate` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `estimated_ad_recallers` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `frequency` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `frequency_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `full_view_impressions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `full_view_reach` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `impressions_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `inline_link_click_ctr` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `inline_link_clicks` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `inline_link_clicks_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `inline_post_engagement` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `inline_post_engagement_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `instant_experience_clicks_to_open` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `instant_experience_clicks_to_start` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `instant_experience_outbound_clicks` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `mobile_app_purchase_roas` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `outbound_clicks` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `outbound_clicks_ctr` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `purchase_roas` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `purchase_roas_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `quality_ranking` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `reach_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `social_spend` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `spend_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_clicks` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_clicks_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_ctr` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_ctr_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_inline_link_clicks` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_inline_link_clicks_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_inline_post_engagement` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_inline_post_engagement_growth` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_link_clicks_ctr` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `unique_outbound_clicks` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_30_sec_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_avg_time_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_continuous_2_sec_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_p100_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_p25_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_p50_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_p75_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_p95_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_play_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_play_curve_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_thruplay_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `video_time_watched_actions` on the `ad_insights_hourly` table. All the data in the column will be lost.
  - You are about to drop the column `website_purchase_roas` on the `ad_insights_hourly` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "CrawlJobType" ADD VALUE 'ALL_ENTITIES';

-- AlterTable
ALTER TABLE "ad_accounts" ADD COLUMN     "branch_id" INTEGER;

-- AlterTable
ALTER TABLE "ad_insights_daily" DROP COLUMN "action_values",
DROP COLUMN "actions",
DROP COLUMN "canvas_avg_view_percent",
DROP COLUMN "canvas_avg_view_time",
DROP COLUMN "catalog_segment_actions",
DROP COLUMN "catalog_segment_value",
DROP COLUMN "conversion_rate_ranking",
DROP COLUMN "conversion_values",
DROP COLUMN "conversions",
DROP COLUMN "cost_per_action_type",
DROP COLUMN "cost_per_conversion",
DROP COLUMN "cost_per_inline_link_click",
DROP COLUMN "cost_per_outbound_click",
DROP COLUMN "cost_per_unique_action_type",
DROP COLUMN "cost_per_unique_click",
DROP COLUMN "cost_per_unique_inline_link_click",
DROP COLUMN "cost_per_unique_outbound_click",
DROP COLUMN "cpp",
DROP COLUMN "date_start",
DROP COLUMN "date_stop",
DROP COLUMN "engagement_rate_ranking",
DROP COLUMN "estimated_ad_recall_rate",
DROP COLUMN "estimated_ad_recallers",
DROP COLUMN "frequency",
DROP COLUMN "full_view_impressions",
DROP COLUMN "full_view_reach",
DROP COLUMN "inline_link_click_ctr",
DROP COLUMN "inline_link_clicks",
DROP COLUMN "inline_post_engagement",
DROP COLUMN "instant_experience_clicks_to_open",
DROP COLUMN "instant_experience_clicks_to_start",
DROP COLUMN "instant_experience_outbound_clicks",
DROP COLUMN "mobile_app_purchase_roas",
DROP COLUMN "outbound_clicks",
DROP COLUMN "outbound_clicks_ctr",
DROP COLUMN "purchase_roas",
DROP COLUMN "quality_ranking",
DROP COLUMN "social_spend",
DROP COLUMN "unique_clicks",
DROP COLUMN "unique_ctr",
DROP COLUMN "unique_inline_link_clicks",
DROP COLUMN "unique_inline_post_engagement",
DROP COLUMN "unique_link_clicks_ctr",
DROP COLUMN "unique_outbound_clicks",
DROP COLUMN "video_30_sec_watched_actions",
DROP COLUMN "video_avg_time_watched_actions",
DROP COLUMN "video_continuous_2_sec_watched_actions",
DROP COLUMN "video_p100_watched_actions",
DROP COLUMN "video_p25_watched_actions",
DROP COLUMN "video_p50_watched_actions",
DROP COLUMN "video_p75_watched_actions",
DROP COLUMN "video_p95_watched_actions",
DROP COLUMN "video_play_actions",
DROP COLUMN "video_play_curve_actions",
DROP COLUMN "video_thruplay_watched_actions",
DROP COLUMN "video_time_watched_actions",
DROP COLUMN "website_purchase_roas";

-- AlterTable
ALTER TABLE "ad_insights_hourly" DROP COLUMN "action_values",
DROP COLUMN "action_values_growth",
DROP COLUMN "actions",
DROP COLUMN "actions_growth",
DROP COLUMN "canvas_avg_view_percent",
DROP COLUMN "canvas_avg_view_time",
DROP COLUMN "catalog_segment_actions",
DROP COLUMN "catalog_segment_value",
DROP COLUMN "clicks_growth",
DROP COLUMN "conversion_rate_ranking",
DROP COLUMN "conversion_values",
DROP COLUMN "conversion_values_growth",
DROP COLUMN "conversions",
DROP COLUMN "conversions_growth",
DROP COLUMN "cost_per_action_type",
DROP COLUMN "cost_per_conversion",
DROP COLUMN "cost_per_inline_link_click",
DROP COLUMN "cost_per_outbound_click",
DROP COLUMN "cost_per_unique_action_type",
DROP COLUMN "cost_per_unique_click",
DROP COLUMN "cost_per_unique_inline_link_click",
DROP COLUMN "cost_per_unique_outbound_click",
DROP COLUMN "cpc_growth",
DROP COLUMN "cpm_growth",
DROP COLUMN "cpp",
DROP COLUMN "ctr_growth",
DROP COLUMN "date_start",
DROP COLUMN "date_stop",
DROP COLUMN "engagement_rate_ranking",
DROP COLUMN "estimated_ad_recall_rate",
DROP COLUMN "estimated_ad_recallers",
DROP COLUMN "frequency",
DROP COLUMN "frequency_growth",
DROP COLUMN "full_view_impressions",
DROP COLUMN "full_view_reach",
DROP COLUMN "impressions_growth",
DROP COLUMN "inline_link_click_ctr",
DROP COLUMN "inline_link_clicks",
DROP COLUMN "inline_link_clicks_growth",
DROP COLUMN "inline_post_engagement",
DROP COLUMN "inline_post_engagement_growth",
DROP COLUMN "instant_experience_clicks_to_open",
DROP COLUMN "instant_experience_clicks_to_start",
DROP COLUMN "instant_experience_outbound_clicks",
DROP COLUMN "mobile_app_purchase_roas",
DROP COLUMN "outbound_clicks",
DROP COLUMN "outbound_clicks_ctr",
DROP COLUMN "purchase_roas",
DROP COLUMN "purchase_roas_growth",
DROP COLUMN "quality_ranking",
DROP COLUMN "reach_growth",
DROP COLUMN "social_spend",
DROP COLUMN "spend_growth",
DROP COLUMN "unique_clicks",
DROP COLUMN "unique_clicks_growth",
DROP COLUMN "unique_ctr",
DROP COLUMN "unique_ctr_growth",
DROP COLUMN "unique_inline_link_clicks",
DROP COLUMN "unique_inline_link_clicks_growth",
DROP COLUMN "unique_inline_post_engagement",
DROP COLUMN "unique_inline_post_engagement_growth",
DROP COLUMN "unique_link_clicks_ctr",
DROP COLUMN "unique_outbound_clicks",
DROP COLUMN "video_30_sec_watched_actions",
DROP COLUMN "video_avg_time_watched_actions",
DROP COLUMN "video_continuous_2_sec_watched_actions",
DROP COLUMN "video_p100_watched_actions",
DROP COLUMN "video_p25_watched_actions",
DROP COLUMN "video_p50_watched_actions",
DROP COLUMN "video_p75_watched_actions",
DROP COLUMN "video_p95_watched_actions",
DROP COLUMN "video_play_actions",
DROP COLUMN "video_play_curve_actions",
DROP COLUMN "video_thruplay_watched_actions",
DROP COLUMN "video_time_watched_actions",
DROP COLUMN "website_purchase_roas";

-- CreateTable
CREATE TABLE "user_telegram_bots" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "ad_account_id" TEXT,
    "bot_token" TEXT NOT NULL,
    "bot_name" TEXT,
    "bot_username" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_telegram_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_bot_subscribers" (
    "id" SERIAL NOT NULL,
    "bot_id" INTEGER NOT NULL,
    "chat_id" TEXT NOT NULL,
    "name" TEXT,
    "receive_notifications" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_bot_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_telegram_bot_settings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "bot_id" INTEGER NOT NULL,
    "allowed_hours" INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_telegram_bot_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_daily_stats" (
    "id" SERIAL NOT NULL,
    "branch_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "total_spend" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total_impressions" BIGINT NOT NULL DEFAULT 0,
    "total_clicks" BIGINT NOT NULL DEFAULT 0,
    "total_reach" BIGINT NOT NULL DEFAULT 0,
    "total_results" BIGINT NOT NULL DEFAULT 0,
    "total_messaging" BIGINT NOT NULL DEFAULT 0,
    "ad_account_count" INTEGER NOT NULL DEFAULT 0,
    "ads_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platforms" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_identities" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "is_valid" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_accounts" (
    "id" SERIAL NOT NULL,
    "platform_identity_id" INTEGER NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "account_status" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezone" TEXT,
    "platform_data" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_credentials" (
    "id" SERIAL NOT NULL,
    "platform_identity_id" INTEGER NOT NULL,
    "credential_type" TEXT NOT NULL,
    "credential_value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_campaigns" (
    "id" TEXT NOT NULL,
    "platform_account_id" INTEGER NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "objective" TEXT,
    "daily_budget" DECIMAL(20,4),
    "lifetime_budget" DECIMAL(20,4),
    "currency" TEXT,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "platform_data" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unified_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_ad_groups" (
    "id" TEXT NOT NULL,
    "unified_campaign_id" TEXT NOT NULL,
    "platform_account_id" INTEGER NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "daily_budget" DECIMAL(20,4),
    "bid_amount" DECIMAL(20,4),
    "targeting" JSONB,
    "platform_data" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unified_ad_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_ads" (
    "id" TEXT NOT NULL,
    "unified_ad_group_id" TEXT NOT NULL,
    "platform_account_id" INTEGER NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "creative_id" TEXT,
    "platform_data" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unified_ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_insights" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "platform_id" INTEGER NOT NULL,
    "platform_account_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "impressions" BIGINT,
    "clicks" BIGINT,
    "spend" DECIMAL(20,4),
    "conversions" BIGINT,
    "results" BIGINT,
    "ctr" DECIMAL(10,6),
    "cpc" DECIMAL(20,4),
    "cpm" DECIMAL(20,4),
    "platform_metrics" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unified_ad_id" TEXT,

    CONSTRAINT "unified_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_telegram_bots_user_id_idx" ON "user_telegram_bots"("user_id");

-- CreateIndex
CREATE INDEX "user_telegram_bots_ad_account_id_idx" ON "user_telegram_bots"("ad_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_telegram_bots_user_id_ad_account_id_key" ON "user_telegram_bots"("user_id", "ad_account_id");

-- CreateIndex
CREATE INDEX "telegram_bot_subscribers_bot_id_idx" ON "telegram_bot_subscribers"("bot_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_bot_subscribers_bot_id_chat_id_key" ON "telegram_bot_subscribers"("bot_id", "chat_id");

-- CreateIndex
CREATE INDEX "user_telegram_bot_settings_user_id_idx" ON "user_telegram_bot_settings"("user_id");

-- CreateIndex
CREATE INDEX "user_telegram_bot_settings_bot_id_idx" ON "user_telegram_bot_settings"("bot_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_telegram_bot_settings_user_id_bot_id_key" ON "user_telegram_bot_settings"("user_id", "bot_id");

-- CreateIndex
CREATE INDEX "branches_user_id_idx" ON "branches"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_user_id_name_key" ON "branches"("user_id", "name");

-- CreateIndex
CREATE INDEX "branch_daily_stats_branch_id_date_idx" ON "branch_daily_stats"("branch_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "branch_daily_stats_branch_id_date_key" ON "branch_daily_stats"("branch_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "platforms_code_key" ON "platforms"("code");

-- CreateIndex
CREATE INDEX "platform_identities_user_id_idx" ON "platform_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_identities_platform_id_external_id_key" ON "platform_identities"("platform_id", "external_id");

-- CreateIndex
CREATE INDEX "platform_accounts_platform_identity_id_idx" ON "platform_accounts"("platform_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_accounts_platform_id_external_id_key" ON "platform_accounts"("platform_id", "external_id");

-- CreateIndex
CREATE INDEX "platform_credentials_platform_identity_id_idx" ON "platform_credentials"("platform_identity_id");

-- CreateIndex
CREATE INDEX "unified_campaigns_platform_account_id_idx" ON "unified_campaigns"("platform_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_campaigns_platform_id_external_id_key" ON "unified_campaigns"("platform_id", "external_id");

-- CreateIndex
CREATE INDEX "unified_ad_groups_unified_campaign_id_idx" ON "unified_ad_groups"("unified_campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_ad_groups_platform_id_external_id_key" ON "unified_ad_groups"("platform_id", "external_id");

-- CreateIndex
CREATE INDEX "unified_ads_unified_ad_group_id_idx" ON "unified_ads"("unified_ad_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "unified_ads_platform_id_external_id_key" ON "unified_ads"("platform_id", "external_id");

-- CreateIndex
CREATE INDEX "unified_insights_platform_account_id_date_idx" ON "unified_insights"("platform_account_id", "date");

-- CreateIndex
CREATE INDEX "unified_insights_date_idx" ON "unified_insights"("date");

-- CreateIndex
CREATE UNIQUE INDEX "unified_insights_entity_type_entity_id_platform_id_date_key" ON "unified_insights"("entity_type", "entity_id", "platform_id", "date");

-- CreateIndex
CREATE INDEX "ad_accounts_branch_id_idx" ON "ad_accounts"("branch_id");

-- AddForeignKey
ALTER TABLE "user_telegram_bots" ADD CONSTRAINT "user_telegram_bots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_telegram_bots" ADD CONSTRAINT "user_telegram_bots_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_bot_subscribers" ADD CONSTRAINT "telegram_bot_subscribers_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "user_telegram_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_telegram_bot_settings" ADD CONSTRAINT "user_telegram_bot_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_telegram_bot_settings" ADD CONSTRAINT "user_telegram_bot_settings_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "user_telegram_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_daily_stats" ADD CONSTRAINT "branch_daily_stats_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_platform_identity_id_fkey" FOREIGN KEY ("platform_identity_id") REFERENCES "platform_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_platform_identity_id_fkey" FOREIGN KEY ("platform_identity_id") REFERENCES "platform_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_campaigns" ADD CONSTRAINT "unified_campaigns_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_campaigns" ADD CONSTRAINT "unified_campaigns_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_ad_groups" ADD CONSTRAINT "unified_ad_groups_unified_campaign_id_fkey" FOREIGN KEY ("unified_campaign_id") REFERENCES "unified_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_ads" ADD CONSTRAINT "unified_ads_unified_ad_group_id_fkey" FOREIGN KEY ("unified_ad_group_id") REFERENCES "unified_ad_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insights" ADD CONSTRAINT "unified_insights_unified_ad_id_fkey" FOREIGN KEY ("unified_ad_id") REFERENCES "unified_ads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
