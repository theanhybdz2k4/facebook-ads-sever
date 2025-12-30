/*
  Warnings:

  - You are about to drop the `account_status_histories` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `accounts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `audit_logs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `notifications` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `permissions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `refresh_tokens` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `role_permissions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `roles` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_roles` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `users` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "CrawlJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CrawlJobType" AS ENUM ('CAMPAIGNS', 'ADSETS', 'ADS', 'CREATIVES', 'IMAGES', 'VIDEOS', 'INSIGHTS_DAILY', 'INSIGHTS_DEVICE', 'INSIGHTS_PLACEMENT', 'INSIGHTS_AGE_GENDER', 'INSIGHTS_REGION', 'INSIGHTS_HOURLY');

-- CreateEnum
CREATE TYPE "TokenType" AS ENUM ('USER', 'PAGE', 'SYSTEM_USER');

-- DropForeignKey
ALTER TABLE "account_status_histories" DROP CONSTRAINT "account_status_histories_account_id_fkey";

-- DropForeignKey
ALTER TABLE "account_status_histories" DROP CONSTRAINT "account_status_histories_user_id_fkey";

-- DropForeignKey
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_current_owner_id_fkey";

-- DropForeignKey
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_last_updated_by_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_account_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_user_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_account_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_fkey";

-- DropForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey";

-- DropForeignKey
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_id_fkey";

-- DropForeignKey
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_fkey";

-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_id_fkey";

-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_role_id_fkey";

-- DropTable
DROP TABLE "account_status_histories";

-- DropTable
DROP TABLE "accounts";

-- DropTable
DROP TABLE "audit_logs";

-- DropTable
DROP TABLE "notifications";

-- DropTable
DROP TABLE "permissions";

-- DropTable
DROP TABLE "refresh_tokens";

-- DropTable
DROP TABLE "role_permissions";

-- DropTable
DROP TABLE "roles";

-- DropTable
DROP TABLE "user_roles";

-- DropTable
DROP TABLE "users";

-- DropEnum
DROP TYPE "AccountStatus";

-- DropEnum
DROP TYPE "AuditLogAction";

-- DropEnum
DROP TYPE "AuthType";

-- DropEnum
DROP TYPE "NotificationType";

-- CreateTable
CREATE TABLE "ad_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "account_status" INTEGER NOT NULL,
    "age" DOUBLE PRECISION,
    "amount_spent" DECIMAL(20,4),
    "balance" DECIMAL(20,4),
    "business_id" TEXT,
    "business_name" TEXT,
    "currency" TEXT NOT NULL,
    "timezone_name" TEXT,
    "timezone_offset_hours_utc" INTEGER,
    "disable_reason" INTEGER,
    "funding_source" TEXT,
    "min_campaign_group_spend_cap" DECIMAL(20,4),
    "min_daily_budget" DECIMAL(20,4),
    "spend_cap" DECIMAL(20,4),
    "owner" TEXT,
    "is_prepay_account" BOOLEAN,
    "created_time" TIMESTAMP(3),
    "end_advertiser" TEXT,
    "end_advertiser_name" TEXT,
    "raw_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT,
    "objective" TEXT,
    "status" TEXT NOT NULL,
    "configured_status" TEXT,
    "effective_status" TEXT,
    "buying_type" TEXT,
    "special_ad_categories" JSONB,
    "special_ad_category" TEXT,
    "special_ad_category_country" JSONB,
    "daily_budget" DECIMAL(20,4),
    "lifetime_budget" DECIMAL(20,4),
    "budget_remaining" DECIMAL(20,4),
    "spend_cap" DECIMAL(20,4),
    "bid_strategy" TEXT,
    "pacing_type" JSONB,
    "start_time" TIMESTAMP(3),
    "stop_time" TIMESTAMP(3),
    "created_time" TIMESTAMP(3),
    "updated_time" TIMESTAMP(3),
    "source_campaign_id" TEXT,
    "boosted_object_id" TEXT,
    "smart_promotion_type" TEXT,
    "is_skadnetwork_attribution" BOOLEAN,
    "issues_info" JSONB,
    "recommendations" JSONB,
    "raw_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adsets" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "configured_status" TEXT,
    "effective_status" TEXT,
    "daily_budget" DECIMAL(20,4),
    "lifetime_budget" DECIMAL(20,4),
    "budget_remaining" DECIMAL(20,4),
    "bid_amount" DECIMAL(20,4),
    "bid_strategy" TEXT,
    "billing_event" TEXT,
    "optimization_goal" TEXT,
    "optimization_sub_event" TEXT,
    "pacing_type" JSONB,
    "targeting" JSONB NOT NULL,
    "promoted_object" JSONB,
    "destination_type" TEXT,
    "attribution_spec" JSONB,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "created_time" TIMESTAMP(3),
    "updated_time" TIMESTAMP(3),
    "learning_stage_info" JSONB,
    "is_dynamic_creative" BOOLEAN,
    "use_new_app_click" BOOLEAN,
    "multi_optimization_goal_weight" TEXT,
    "rf_prediction_id" TEXT,
    "recurring_budget_semantics" TEXT,
    "review_feedback" TEXT,
    "source_adset_id" TEXT,
    "issues_info" JSONB,
    "recommendations" JSONB,
    "raw_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adsets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads" (
    "id" TEXT NOT NULL,
    "adset_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "creative_id" TEXT,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "configured_status" TEXT,
    "effective_status" TEXT,
    "creative" JSONB,
    "tracking_specs" JSONB,
    "conversion_specs" JSONB,
    "ad_review_feedback" JSONB,
    "preview_shareable_link" TEXT,
    "source_ad_id" TEXT,
    "created_time" TIMESTAMP(3),
    "updated_time" TIMESTAMP(3),
    "demolink_hash" TEXT,
    "engagement_audience" BOOLEAN,
    "issues_info" JSONB,
    "recommendations" JSONB,
    "raw_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "body" TEXT,
    "description" TEXT,
    "link_url" TEXT,
    "link_destination_display_url" TEXT,
    "call_to_action_type" TEXT,
    "image_hash" TEXT,
    "image_url" TEXT,
    "video_id" TEXT,
    "thumbnail_url" TEXT,
    "object_story_spec" JSONB,
    "object_story_id" TEXT,
    "effective_object_story_id" TEXT,
    "object_id" TEXT,
    "object_type" TEXT,
    "instagram_actor_id" TEXT,
    "instagram_permalink_url" TEXT,
    "product_set_id" TEXT,
    "asset_feed_spec" JSONB,
    "degrees_of_freedom_spec" JSONB,
    "contextual_multi_ads" JSONB,
    "url_tags" TEXT,
    "template_url" TEXT,
    "template_url_spec" JSONB,
    "use_page_actor_override" BOOLEAN,
    "authorization_category" TEXT,
    "run_status" TEXT,
    "status" TEXT,
    "created_time" TIMESTAMP(3),
    "raw_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_images" (
    "hash" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "id" TEXT,
    "name" TEXT,
    "url" TEXT,
    "url_128" TEXT,
    "permalink_url" TEXT,
    "original_width" INTEGER,
    "original_height" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "status" TEXT,
    "created_time" TIMESTAMP(3),
    "updated_time" TIMESTAMP(3),
    "raw_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_images_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "ad_videos" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "source" TEXT,
    "picture" TEXT,
    "embed_html" TEXT,
    "length" DOUBLE PRECISION,
    "format" JSONB,
    "status" JSONB,
    "ad_breaks" JSONB,
    "content_category" TEXT,
    "universal_video_id" TEXT,
    "is_crossposting_eligible" BOOLEAN,
    "is_instagram_eligible" BOOLEAN,
    "created_time" TIMESTAMP(3),
    "updated_time" TIMESTAMP(3),
    "raw_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_daily" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "ad_id" TEXT NOT NULL,
    "adset_id" TEXT,
    "campaign_id" TEXT,
    "account_id" TEXT NOT NULL,
    "impressions" BIGINT,
    "reach" BIGINT,
    "frequency" DECIMAL(10,4),
    "clicks" BIGINT,
    "unique_clicks" BIGINT,
    "inline_link_clicks" BIGINT,
    "unique_inline_link_clicks" BIGINT,
    "outbound_clicks" JSONB,
    "unique_outbound_clicks" JSONB,
    "ctr" DECIMAL(10,4),
    "unique_ctr" DECIMAL(10,4),
    "inline_link_click_ctr" DECIMAL(10,4),
    "unique_link_clicks_ctr" DECIMAL(10,4),
    "outbound_clicks_ctr" JSONB,
    "spend" DECIMAL(20,4),
    "cpc" DECIMAL(20,4),
    "cpm" DECIMAL(20,4),
    "cpp" DECIMAL(20,4),
    "cost_per_unique_click" DECIMAL(20,4),
    "cost_per_inline_link_click" DECIMAL(20,4),
    "cost_per_unique_inline_link_click" DECIMAL(20,4),
    "cost_per_outbound_click" JSONB,
    "cost_per_unique_outbound_click" JSONB,
    "actions" JSONB,
    "action_values" JSONB,
    "conversions" JSONB,
    "conversion_values" JSONB,
    "cost_per_action_type" JSONB,
    "cost_per_conversion" JSONB,
    "cost_per_unique_action_type" JSONB,
    "purchase_roas" JSONB,
    "website_purchase_roas" JSONB,
    "mobile_app_purchase_roas" JSONB,
    "video_play_actions" JSONB,
    "video_p25_watched_actions" JSONB,
    "video_p50_watched_actions" JSONB,
    "video_p75_watched_actions" JSONB,
    "video_p95_watched_actions" JSONB,
    "video_p100_watched_actions" JSONB,
    "video_30_sec_watched_actions" JSONB,
    "video_avg_time_watched_actions" JSONB,
    "video_time_watched_actions" JSONB,
    "video_play_curve_actions" JSONB,
    "video_thruplay_watched_actions" JSONB,
    "video_continuous_2_sec_watched_actions" JSONB,
    "social_spend" DECIMAL(20,4),
    "inline_post_engagement" BIGINT,
    "unique_inline_post_engagement" BIGINT,
    "quality_ranking" TEXT,
    "engagement_rate_ranking" TEXT,
    "conversion_rate_ranking" TEXT,
    "canvas_avg_view_time" DECIMAL(10,4),
    "canvas_avg_view_percent" DECIMAL(10,4),
    "catalog_segment_actions" JSONB,
    "catalog_segment_value" JSONB,
    "estimated_ad_recallers" BIGINT,
    "estimated_ad_recall_rate" DECIMAL(10,4),
    "instant_experience_clicks_to_open" JSONB,
    "instant_experience_clicks_to_start" JSONB,
    "instant_experience_outbound_clicks" JSONB,
    "full_view_reach" BIGINT,
    "full_view_impressions" BIGINT,
    "date_start" DATE,
    "date_stop" DATE,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_insights_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_device_daily" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "ad_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "device_platform" TEXT NOT NULL,
    "impressions" BIGINT,
    "reach" BIGINT,
    "clicks" BIGINT,
    "unique_clicks" BIGINT,
    "spend" DECIMAL(20,4),
    "actions" JSONB,
    "action_values" JSONB,
    "conversions" JSONB,
    "cost_per_action_type" JSONB,
    "video_thruplay_watched_actions" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_insights_device_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_placement_daily" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "ad_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "publisher_platform" TEXT NOT NULL,
    "platform_position" TEXT NOT NULL,
    "impression_device" TEXT,
    "impressions" BIGINT,
    "reach" BIGINT,
    "clicks" BIGINT,
    "unique_clicks" BIGINT,
    "spend" DECIMAL(20,4),
    "actions" JSONB,
    "action_values" JSONB,
    "conversions" JSONB,
    "cost_per_action_type" JSONB,
    "video_thruplay_watched_actions" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_insights_placement_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_age_gender_daily" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "ad_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "age" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "impressions" BIGINT,
    "reach" BIGINT,
    "clicks" BIGINT,
    "unique_clicks" BIGINT,
    "spend" DECIMAL(20,4),
    "actions" JSONB,
    "action_values" JSONB,
    "conversions" JSONB,
    "cost_per_action_type" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_insights_age_gender_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_region_daily" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "ad_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "region" TEXT,
    "impressions" BIGINT,
    "reach" BIGINT,
    "clicks" BIGINT,
    "unique_clicks" BIGINT,
    "spend" DECIMAL(20,4),
    "actions" JSONB,
    "action_values" JSONB,
    "conversions" JSONB,
    "cost_per_action_type" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_insights_region_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_hourly" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "ad_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "hourly_stats_aggregated_by_advertiser_time_zone" TEXT NOT NULL,
    "impressions" BIGINT,
    "reach" BIGINT,
    "clicks" BIGINT,
    "spend" DECIMAL(20,4),
    "actions" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_insights_hourly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_jobs" (
    "id" SERIAL NOT NULL,
    "account_id" TEXT NOT NULL,
    "job_type" "CrawlJobType" NOT NULL,
    "status" "CrawlJobStatus" NOT NULL DEFAULT 'PENDING',
    "date_start" DATE,
    "date_end" DATE,
    "breakdown" TEXT,
    "level" TEXT,
    "total_records" INTEGER,
    "processed_records" INTEGER,
    "error_message" TEXT,
    "error_code" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fb_api_tokens" (
    "id" SERIAL NOT NULL,
    "account_id" TEXT,
    "user_id" TEXT,
    "access_token" TEXT NOT NULL,
    "token_type" "TokenType" NOT NULL DEFAULT 'USER',
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3),
    "data_access_expires_at" TIMESTAMP(3),
    "is_valid" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "fb_api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_account_id_idx" ON "campaigns"("account_id");

-- CreateIndex
CREATE INDEX "campaigns_status_effective_status_idx" ON "campaigns"("status", "effective_status");

-- CreateIndex
CREATE INDEX "adsets_campaign_id_idx" ON "adsets"("campaign_id");

-- CreateIndex
CREATE INDEX "adsets_account_id_idx" ON "adsets"("account_id");

-- CreateIndex
CREATE INDEX "adsets_status_effective_status_idx" ON "adsets"("status", "effective_status");

-- CreateIndex
CREATE INDEX "ads_adset_id_idx" ON "ads"("adset_id");

-- CreateIndex
CREATE INDEX "ads_campaign_id_idx" ON "ads"("campaign_id");

-- CreateIndex
CREATE INDEX "ads_account_id_idx" ON "ads"("account_id");

-- CreateIndex
CREATE INDEX "ads_creative_id_idx" ON "ads"("creative_id");

-- CreateIndex
CREATE INDEX "ads_status_effective_status_idx" ON "ads"("status", "effective_status");

-- CreateIndex
CREATE INDEX "creatives_account_id_idx" ON "creatives"("account_id");

-- CreateIndex
CREATE INDEX "creatives_image_hash_idx" ON "creatives"("image_hash");

-- CreateIndex
CREATE INDEX "creatives_video_id_idx" ON "creatives"("video_id");

-- CreateIndex
CREATE INDEX "ad_images_account_id_idx" ON "ad_images"("account_id");

-- CreateIndex
CREATE INDEX "ad_videos_account_id_idx" ON "ad_videos"("account_id");

-- CreateIndex
CREATE INDEX "ad_insights_daily_ad_id_date_idx" ON "ad_insights_daily"("ad_id", "date");

-- CreateIndex
CREATE INDEX "ad_insights_daily_date_idx" ON "ad_insights_daily"("date");

-- CreateIndex
CREATE INDEX "ad_insights_daily_account_id_date_idx" ON "ad_insights_daily"("account_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_daily_date_ad_id_key" ON "ad_insights_daily"("date", "ad_id");

-- CreateIndex
CREATE INDEX "ad_insights_device_daily_ad_id_date_idx" ON "ad_insights_device_daily"("ad_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_device_daily_date_ad_id_device_platform_key" ON "ad_insights_device_daily"("date", "ad_id", "device_platform");

-- CreateIndex
CREATE INDEX "ad_insights_placement_daily_ad_id_date_idx" ON "ad_insights_placement_daily"("ad_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_placement_daily_date_ad_id_publisher_platform_p_key" ON "ad_insights_placement_daily"("date", "ad_id", "publisher_platform", "platform_position");

-- CreateIndex
CREATE INDEX "ad_insights_age_gender_daily_ad_id_date_idx" ON "ad_insights_age_gender_daily"("ad_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_age_gender_daily_date_ad_id_age_gender_key" ON "ad_insights_age_gender_daily"("date", "ad_id", "age", "gender");

-- CreateIndex
CREATE INDEX "ad_insights_region_daily_ad_id_date_idx" ON "ad_insights_region_daily"("ad_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_region_daily_date_ad_id_country_region_key" ON "ad_insights_region_daily"("date", "ad_id", "country", "region");

-- CreateIndex
CREATE INDEX "ad_insights_hourly_ad_id_date_idx" ON "ad_insights_hourly"("ad_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_hourly_date_ad_id_hourly_stats_aggregated_by_ad_key" ON "ad_insights_hourly"("date", "ad_id", "hourly_stats_aggregated_by_advertiser_time_zone");

-- CreateIndex
CREATE INDEX "crawl_jobs_status_created_at_idx" ON "crawl_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "crawl_jobs_account_id_job_type_idx" ON "crawl_jobs"("account_id", "job_type");

-- CreateIndex
CREATE INDEX "fb_api_tokens_account_id_idx" ON "fb_api_tokens"("account_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adsets" ADD CONSTRAINT "adsets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adsets" ADD CONSTRAINT "adsets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_adset_id_fkey" FOREIGN KEY ("adset_id") REFERENCES "adsets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_creative_id_fkey" FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_image_hash_fkey" FOREIGN KEY ("image_hash") REFERENCES "ad_images"("hash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "ad_videos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_images" ADD CONSTRAINT "ad_images_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_videos" ADD CONSTRAINT "ad_videos_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_daily" ADD CONSTRAINT "ad_insights_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_daily" ADD CONSTRAINT "ad_insights_daily_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_device_daily" ADD CONSTRAINT "ad_insights_device_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_device_daily" ADD CONSTRAINT "ad_insights_device_daily_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_placement_daily" ADD CONSTRAINT "ad_insights_placement_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_placement_daily" ADD CONSTRAINT "ad_insights_placement_daily_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_age_gender_daily" ADD CONSTRAINT "ad_insights_age_gender_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_age_gender_daily" ADD CONSTRAINT "ad_insights_age_gender_daily_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_region_daily" ADD CONSTRAINT "ad_insights_region_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_region_daily" ADD CONSTRAINT "ad_insights_region_daily_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_hourly" ADD CONSTRAINT "ad_insights_hourly_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_insights_hourly" ADD CONSTRAINT "ad_insights_hourly_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fb_api_tokens" ADD CONSTRAINT "fb_api_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
