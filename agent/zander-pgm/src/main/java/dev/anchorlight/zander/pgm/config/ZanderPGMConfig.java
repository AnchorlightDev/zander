package dev.anchorlight.zander.pgm.config;

import java.util.HashMap;
import java.util.Map;

/**
 * Immutable-ish snapshot of the plugin configuration. Populated by
 * {@link ConfigLoader}. Grouped to mirror the structure of {@code config.yml}.
 */
public class ZanderPGMConfig {

    // server.*
    public String serverId = "mixed-1";
    public String serverDisplayName = "Mixed Server 1";
    public String environment = "production";

    // api.*
    public String baseUrl = "https://craftingforchrist.net/api";
    public String websocketUrl = "wss://zander-web.example.com/ws/mixed";
    public String token = "change-me";
    public int connectTimeoutSeconds = 10;
    public int requestTimeoutSeconds = 15;

    // logging.*
    public boolean debugLogging = false;

    // sync.*
    public int heartbeatSeconds = 30;
    public boolean retryFailedEvents = true;
    public int retrySeconds = 30;
    public int maxQueueSize = 10000;
    public boolean batchEvents = true;
    public int maxBatchSize = 100;

    // features.*
    public final Map<String, Boolean> features = new HashMap<>();

    // stats.*
    public int saveIntervalSeconds = 60;
    public boolean includeDamageStats = true;
    public boolean includeBlockStats = true;
    public boolean includeBowStats = true;
    public boolean includeObjectiveStats = true;
    public boolean includeSessionStats = true;

    // xp.*
    public int xpWin = 100;
    public int xpLoss = 25;
    public int xpKill = 10;
    public int xpAssist = 5;
    public int xpObjectiveCapture = 50;
    public int xpObjectiveDefend = 20;
    public int xpFirstBlood = 25;
    public int xpKillstreakBonus = 10;

    // mapTokens.*
    public boolean mapTokensEnabled = true;
    public String mapTokenApplyMode = "NEXT_MATCH";
    public boolean mapTokenAllowMidMatchChange = false;
    public int mapTokenPlayerCooldownMinutes = 60;
    public int mapTokenMapCooldownMatches = 5;
    public int mapTokenMinimumPlayersOnline = 4;
    public boolean mapTokenRefundIfFailed = true;
    public boolean mapTokenRequireMapEnabled = true;

    // mapVoting.*
    public boolean mapVotingEnabled = true;
    public int voteDurationSeconds = 45;
    public int optionsPerVote = 4;
    public boolean allowTokenNominations = true;
    public boolean allowTokenBoosts = true;
    public int tokenBoostWeight = 2;
    public int mapVoteCooldownMatches = 5;
    public boolean showLiveResults = true;
    public boolean applyWinnerToNextMatch = true;

    // mapRatings.*
    public boolean mapRatingsEnabled = true;
    public boolean promptAfterMatch = true;
    public int ratingWindowSeconds = 180;
    public boolean requirePlayedMatch = true;
    public boolean allowFeedback = true;
    public int feedbackMaxLength = 300;
    public boolean allowRatingUpdatesDuringWindow = true;

    public boolean feature(String key) {
        return features.getOrDefault(key, false);
    }

    /** True when the config still holds a placeholder value that must be changed. */
    public boolean isPlaceholderToken() {
        return token == null || token.isBlank() || token.equals("change-me");
    }
}
