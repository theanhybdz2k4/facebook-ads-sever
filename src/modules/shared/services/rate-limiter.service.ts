import { Injectable, Logger } from '@nestjs/common';

interface ThrottleInfo {
    appIdUtilPct: number;
    accIdUtilPct: number;
    adsApiAccessTier: string;
}

interface RateLimitState {
    throttleInfo: ThrottleInfo | null;
    lastUpdated: Date;
    isPaused: boolean;
    pauseUntil: Date | null;
}

@Injectable()
export class RateLimiterService {
    private readonly logger = new Logger(RateLimiterService.name);
    private state: Map<string, RateLimitState> = new Map();
    private readonly THRESHOLD = 70;
    private readonly PAUSE_DURATION_MS = 30000; // 30 seconds

    /**
     * Parse throttle header from FB API response
     */
    parseThrottleHeader(header: string | undefined, accountId: string): void {
        if (!header) return;

        try {
            const info = JSON.parse(header);
            const throttleInfo: ThrottleInfo = {
                appIdUtilPct: info.app_id_util_pct || 0,
                accIdUtilPct: info.acc_id_util_pct || 0,
                adsApiAccessTier: info.ads_api_access_tier || 'unknown',
            };

            this.state.set(accountId, {
                throttleInfo,
                lastUpdated: new Date(),
                isPaused: throttleInfo.accIdUtilPct >= this.THRESHOLD,
                pauseUntil: throttleInfo.accIdUtilPct >= this.THRESHOLD
                    ? new Date(Date.now() + this.PAUSE_DURATION_MS)
                    : null,
            });

            if (throttleInfo.accIdUtilPct >= this.THRESHOLD) {
                this.logger.warn(
                    `Rate limit threshold reached for ${accountId}: ${throttleInfo.accIdUtilPct}% used. Pausing for ${this.PAUSE_DURATION_MS / 1000}s.`,
                );
            }
        } catch (e) {
            this.logger.error(`Failed to parse throttle header: ${e.message}`);
        }
    }

    /**
     * Check if we should pause requests for an account
     */
    shouldPause(accountId: string): boolean {
        const state = this.state.get(accountId);
        if (!state) return false;

        if (state.isPaused && state.pauseUntil) {
            if (new Date() < state.pauseUntil) {
                return true;
            }
            // Reset pause state
            state.isPaused = false;
            state.pauseUntil = null;
        }

        return false;
    }

    /**
     * Get remaining pause time in ms
     */
    getPauseTimeMs(accountId: string): number {
        const state = this.state.get(accountId);
        if (!state?.pauseUntil) return 0;

        const remaining = state.pauseUntil.getTime() - Date.now();
        return Math.max(0, remaining);
    }

    /**
     * Wait if rate limited
     */
    async waitIfNeeded(accountId: string): Promise<void> {
        const pauseTime = this.getPauseTimeMs(accountId);
        if (pauseTime > 0) {
            this.logger.log(`Pausing ${pauseTime}ms for account ${accountId}`);
            await this.delay(pauseTime);
        }
    }

    /**
     * Get current usage percentage
     */
    getUsage(accountId: string): number {
        return this.state.get(accountId)?.throttleInfo?.accIdUtilPct || 0;
    }

    /**
     * Get all rate limit states
     */
    getAllStates(): Record<string, RateLimitState> {
        const result: Record<string, RateLimitState> = {};
        this.state.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

