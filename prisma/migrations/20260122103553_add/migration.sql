-- CreateIndex
CREATE INDEX "branch_daily_stats_branch_id_date_idx" ON "branch_daily_stats"("branch_id", "date");

-- CreateIndex
CREATE INDEX "branch_daily_stats_branch_id_platform_code_idx" ON "branch_daily_stats"("branch_id", "platform_code");

-- CreateIndex
CREATE INDEX "unified_ad_groups_platform_account_id_status_idx" ON "unified_ad_groups"("platform_account_id", "status");

-- CreateIndex
CREATE INDEX "unified_ad_groups_platform_account_id_created_at_idx" ON "unified_ad_groups"("platform_account_id", "created_at");

-- CreateIndex
CREATE INDEX "unified_ads_platform_account_id_created_at_idx" ON "unified_ads"("platform_account_id", "created_at");

-- CreateIndex
CREATE INDEX "unified_campaigns_platform_account_id_status_idx" ON "unified_campaigns"("platform_account_id", "status");

-- CreateIndex
CREATE INDEX "unified_campaigns_platform_account_id_created_at_idx" ON "unified_campaigns"("platform_account_id", "created_at");
