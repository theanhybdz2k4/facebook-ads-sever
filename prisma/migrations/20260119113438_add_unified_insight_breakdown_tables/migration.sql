/*
  Warnings:

  - You are about to drop the column `creative_data` on the `unified_ads` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "unified_ads" DROP COLUMN "creative_data",
ADD COLUMN     "unified_ad_creative_id" TEXT;

-- CreateTable
CREATE TABLE "unified_ad_creatives" (
    "id" TEXT NOT NULL,
    "platform_account_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "body" TEXT,
    "image_url" TEXT,
    "thumbnail_url" TEXT,
    "title" TEXT,
    "platform_data" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unified_ad_creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_insight_devices" (
    "id" TEXT NOT NULL,
    "unified_insight_id" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "impression_device" TEXT,
    "spend" DECIMAL(20,4),
    "impressions" BIGINT,
    "clicks" BIGINT,
    "results" BIGINT,

    CONSTRAINT "unified_insight_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_insight_age_gender" (
    "id" TEXT NOT NULL,
    "unified_insight_id" TEXT NOT NULL,
    "age" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "spend" DECIMAL(20,4),
    "impressions" BIGINT,
    "clicks" BIGINT,
    "results" BIGINT,

    CONSTRAINT "unified_insight_age_gender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unified_insight_regions" (
    "id" TEXT NOT NULL,
    "unified_insight_id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "country" TEXT,
    "spend" DECIMAL(20,4),
    "impressions" BIGINT,
    "clicks" BIGINT,
    "results" BIGINT,

    CONSTRAINT "unified_insight_regions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unified_ad_creatives_platform_account_id_external_id_key" ON "unified_ad_creatives"("platform_account_id", "external_id");

-- CreateIndex
CREATE INDEX "unified_insight_devices_unified_insight_id_idx" ON "unified_insight_devices"("unified_insight_id");

-- CreateIndex
CREATE INDEX "unified_insight_age_gender_unified_insight_id_idx" ON "unified_insight_age_gender"("unified_insight_id");

-- CreateIndex
CREATE INDEX "unified_insight_regions_unified_insight_id_idx" ON "unified_insight_regions"("unified_insight_id");

-- CreateIndex
CREATE INDEX "unified_ads_unified_ad_creative_id_idx" ON "unified_ads"("unified_ad_creative_id");

-- AddForeignKey
ALTER TABLE "unified_ads" ADD CONSTRAINT "unified_ads_unified_ad_creative_id_fkey" FOREIGN KEY ("unified_ad_creative_id") REFERENCES "unified_ad_creatives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_ad_creatives" ADD CONSTRAINT "unified_ad_creatives_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insight_devices" ADD CONSTRAINT "unified_insight_devices_unified_insight_id_fkey" FOREIGN KEY ("unified_insight_id") REFERENCES "unified_insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insight_age_gender" ADD CONSTRAINT "unified_insight_age_gender_unified_insight_id_fkey" FOREIGN KEY ("unified_insight_id") REFERENCES "unified_insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unified_insight_regions" ADD CONSTRAINT "unified_insight_regions_unified_insight_id_fkey" FOREIGN KEY ("unified_insight_id") REFERENCES "unified_insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
