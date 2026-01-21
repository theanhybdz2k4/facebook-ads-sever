-- CreateIndex
CREATE INDEX "unified_ads_platform_account_id_status_idx" ON "unified_ads"("platform_account_id", "status");

-- CreateIndex
CREATE INDEX "unified_ads_platform_account_id_effective_status_idx" ON "unified_ads"("platform_account_id", "effective_status");

-- CreateIndex
CREATE INDEX "unified_insights_unified_campaign_id_date_idx" ON "unified_insights"("unified_campaign_id", "date");

-- CreateIndex
CREATE INDEX "unified_insights_unified_ad_group_id_date_idx" ON "unified_insights"("unified_ad_group_id", "date");

-- CreateIndex
CREATE INDEX "unified_insights_unified_ad_id_date_idx" ON "unified_insights"("unified_ad_id", "date");
