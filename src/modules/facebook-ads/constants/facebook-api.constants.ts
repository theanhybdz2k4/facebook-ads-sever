// Facebook Graph API Base URL
export const FB_GRAPH_API_URL = 'https://graph.facebook.com/v21.0';

// Rate Limit Thresholds
export const RATE_LIMIT_THRESHOLD = 70; // Pause when usage > 70%
export const RATE_LIMIT_PAUSE_MS = 30000; // 30 seconds pause
export const ACCOUNT_DELAY_MS = 5000; // 5 seconds delay between accounts

// Sync timing
export const INSIGHTS_SYNC_BUFFER_MINUTE = 50; // Stop insights sync at :50
export const ENTITY_SYNC_PAUSE_HOUR = 2; // Pause insights during 2:00-2:30 AM

// Entity fields to fetch
export const AD_ACCOUNT_FIELDS = [
    'id', 'name', 'account_status', 'age', 'amount_spent', 'balance',
    'business', 'currency', 'timezone_name', 'timezone_offset_hours_utc',
    'disable_reason', 'funding_source', 'min_campaign_group_spend_cap',
    'min_daily_budget', 'spend_cap', 'owner', 'is_prepay_account',
    'created_time', 'end_advertiser', 'end_advertiser_name'
].join(',');

export const CAMPAIGN_FIELDS = [
    'id', 'account_id', 'name', 'objective', 'status', 'configured_status',
    'effective_status', 'buying_type', 'special_ad_categories', 'special_ad_category',
    'special_ad_category_country', 'daily_budget', 'lifetime_budget', 'budget_remaining',
    'spend_cap', 'bid_strategy', 'pacing_type', 'start_time', 'stop_time',
    'created_time', 'updated_time', 'source_campaign_id', 'boosted_object_id',
    'smart_promotion_type', 'is_skadnetwork_attribution', 'issues_info', 'recommendations'
].join(',');

export const ADSET_FIELDS = [
    'id', 'campaign_id', 'account_id', 'name', 'status', 'configured_status',
    'effective_status', 'daily_budget', 'lifetime_budget', 'budget_remaining',
    'bid_amount', 'bid_strategy', 'billing_event', 'optimization_goal',
    'optimization_sub_event', 'pacing_type', 'targeting', 'promoted_object',
    'destination_type', 'attribution_spec', 'start_time', 'end_time',
    'created_time', 'updated_time', 'learning_stage_info', 'is_dynamic_creative',
    'use_new_app_click', 'multi_optimization_goal_weight', 'rf_prediction_id',
    'recurring_budget_semantics', 'review_feedback', 'source_adset_id',
    'issues_info', 'recommendations'
].join(',');

export const AD_FIELDS = [
    'id', 'adset_id', 'campaign_id', 'account_id', 'creative', 'name',
    'status', 'configured_status', 'effective_status', 'tracking_specs',
    'conversion_specs', 'ad_review_feedback', 'preview_shareable_link',
    'source_ad_id', 'created_time', 'updated_time', 'demolink_hash',
    'engagement_audience', 'issues_info', 'recommendations'
].join(',');

export const CREATIVE_FIELDS = [
    'id', 'account_id', 'name', 'title', 'body', 'description', 'link_url',
    'link_destination_display_url', 'call_to_action_type', 'image_hash',
    'image_url', 'video_id', 'thumbnail_url', 'object_story_spec',
    'object_story_id', 'effective_object_story_id', 'object_id', 'object_type',
    'instagram_actor_id', 'instagram_permalink_url', 'product_set_id',
    'asset_feed_spec', 'degrees_of_freedom_spec', 'contextual_multi_ads',
    'url_tags', 'template_url', 'template_url_spec', 'use_page_actor_override',
    'authorization_category', 'run_status', 'status'
].join(',');

// Insights fields
export const INSIGHTS_FIELDS = [
    'impressions', 'reach', 'frequency', 'clicks', 'unique_clicks',
    'inline_link_clicks', 'unique_inline_link_clicks', 'outbound_clicks',
    'unique_outbound_clicks', 'ctr', 'unique_ctr', 'inline_link_click_ctr',
    'unique_link_clicks_ctr', 'outbound_clicks_ctr', 'spend', 'cpc', 'cpm', 'cpp',
    'cost_per_unique_click', 'cost_per_inline_link_click',
    'cost_per_unique_inline_link_click', 'cost_per_outbound_click',
    'cost_per_unique_outbound_click', 'actions', 'action_values', 'conversions',
    'conversion_values', 'cost_per_action_type', 'cost_per_conversion',
    'cost_per_unique_action_type', 'purchase_roas', 'website_purchase_roas',
    'mobile_app_purchase_roas', 'video_play_actions', 'video_p25_watched_actions',
    'video_p50_watched_actions', 'video_p75_watched_actions',
    'video_p95_watched_actions', 'video_p100_watched_actions',
    'video_30_sec_watched_actions', 'video_avg_time_watched_actions',
    'video_time_watched_actions', 'video_play_curve_actions',
    'video_thruplay_watched_actions', 'video_continuous_2_sec_watched_actions',
    'social_spend', 'inline_post_engagement',
    'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking',
    'canvas_avg_view_time', 'canvas_avg_view_percent', 'catalog_segment_actions',
    'catalog_segment_value', 'estimated_ad_recallers', 'estimated_ad_recall_rate',
    'instant_experience_clicks_to_open', 'instant_experience_clicks_to_start',
    'instant_experience_outbound_clicks', 'full_view_reach', 'full_view_impressions'
].join(',');

// Insights breakdown fields (smaller set)
export const INSIGHTS_BREAKDOWN_FIELDS = [
    'impressions', 'reach', 'clicks', 'unique_clicks', 'spend',
    'actions', 'action_values', 'conversions', 'cost_per_action_type',
    'video_thruplay_watched_actions'
].join(',');
