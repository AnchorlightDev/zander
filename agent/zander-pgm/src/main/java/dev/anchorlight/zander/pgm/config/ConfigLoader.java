package dev.anchorlight.zander.pgm.config;

import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.FileConfiguration;

/** Reads a Bukkit {@link FileConfiguration} into a {@link ZanderPGMConfig}. */
public final class ConfigLoader {

    private ConfigLoader() {
    }

    public static ZanderPGMConfig load(FileConfiguration c) {
        ZanderPGMConfig cfg = new ZanderPGMConfig();

        cfg.serverId = c.getString("server.id", cfg.serverId);
        cfg.serverDisplayName = c.getString("server.displayName", cfg.serverDisplayName);
        cfg.environment = c.getString("server.environment", cfg.environment);

        cfg.baseUrl = c.getString("api.baseUrl", cfg.baseUrl);
        cfg.websocketUrl = c.getString("api.websocketUrl", cfg.websocketUrl);
        cfg.token = c.getString("api.token", cfg.token);
        cfg.connectTimeoutSeconds = c.getInt("api.connectTimeoutSeconds", cfg.connectTimeoutSeconds);
        cfg.requestTimeoutSeconds = c.getInt("api.requestTimeoutSeconds", cfg.requestTimeoutSeconds);

        cfg.debugLogging = c.getBoolean("logging.debug", cfg.debugLogging);

        cfg.heartbeatSeconds = c.getInt("sync.heartbeatSeconds", cfg.heartbeatSeconds);
        cfg.retryFailedEvents = c.getBoolean("sync.retryFailedEvents", cfg.retryFailedEvents);
        cfg.retrySeconds = c.getInt("sync.retrySeconds", cfg.retrySeconds);
        cfg.maxQueueSize = c.getInt("sync.maxQueueSize", cfg.maxQueueSize);
        cfg.batchEvents = c.getBoolean("sync.batchEvents", cfg.batchEvents);
        cfg.maxBatchSize = c.getInt("sync.maxBatchSize", cfg.maxBatchSize);

        ConfigurationSection features = c.getConfigurationSection("features");
        if (features != null) {
            for (String key : features.getKeys(false)) {
                cfg.features.put(key, features.getBoolean(key));
            }
        }

        cfg.saveIntervalSeconds = c.getInt("stats.saveIntervalSeconds", cfg.saveIntervalSeconds);
        cfg.includeDamageStats = c.getBoolean("stats.includeDamageStats", cfg.includeDamageStats);
        cfg.includeBlockStats = c.getBoolean("stats.includeBlockStats", cfg.includeBlockStats);
        cfg.includeBowStats = c.getBoolean("stats.includeBowStats", cfg.includeBowStats);
        cfg.includeObjectiveStats = c.getBoolean("stats.includeObjectiveStats", cfg.includeObjectiveStats);
        cfg.includeSessionStats = c.getBoolean("stats.includeSessionStats", cfg.includeSessionStats);

        cfg.xpWin = c.getInt("xp.win", cfg.xpWin);
        cfg.xpLoss = c.getInt("xp.loss", cfg.xpLoss);
        cfg.xpKill = c.getInt("xp.kill", cfg.xpKill);
        cfg.xpAssist = c.getInt("xp.assist", cfg.xpAssist);
        cfg.xpObjectiveCapture = c.getInt("xp.objectiveCapture", cfg.xpObjectiveCapture);
        cfg.xpObjectiveDefend = c.getInt("xp.objectiveDefend", cfg.xpObjectiveDefend);
        cfg.xpFirstBlood = c.getInt("xp.firstBlood", cfg.xpFirstBlood);
        cfg.xpKillstreakBonus = c.getInt("xp.killstreakBonus", cfg.xpKillstreakBonus);

        cfg.mapTokensEnabled = c.getBoolean("mapTokens.enabled", cfg.mapTokensEnabled);
        cfg.mapTokenApplyMode = c.getString("mapTokens.applyMode", cfg.mapTokenApplyMode);
        cfg.mapTokenAllowMidMatchChange = c.getBoolean("mapTokens.allowMidMatchChange", cfg.mapTokenAllowMidMatchChange);
        cfg.mapTokenPlayerCooldownMinutes = c.getInt("mapTokens.playerCooldownMinutes", cfg.mapTokenPlayerCooldownMinutes);
        cfg.mapTokenMapCooldownMatches = c.getInt("mapTokens.mapCooldownMatches", cfg.mapTokenMapCooldownMatches);
        cfg.mapTokenMinimumPlayersOnline = c.getInt("mapTokens.minimumPlayersOnline", cfg.mapTokenMinimumPlayersOnline);
        cfg.mapTokenRefundIfFailed = c.getBoolean("mapTokens.refundIfFailed", cfg.mapTokenRefundIfFailed);
        cfg.mapTokenRequireMapEnabled = c.getBoolean("mapTokens.requireMapEnabled", cfg.mapTokenRequireMapEnabled);

        cfg.mapVotingEnabled = c.getBoolean("mapVoting.enabled", cfg.mapVotingEnabled);
        cfg.voteDurationSeconds = c.getInt("mapVoting.voteDurationSeconds", cfg.voteDurationSeconds);
        cfg.optionsPerVote = c.getInt("mapVoting.optionsPerVote", cfg.optionsPerVote);
        cfg.allowTokenNominations = c.getBoolean("mapVoting.allowTokenNominations", cfg.allowTokenNominations);
        cfg.allowTokenBoosts = c.getBoolean("mapVoting.allowTokenBoosts", cfg.allowTokenBoosts);
        cfg.tokenBoostWeight = c.getInt("mapVoting.tokenBoostWeight", cfg.tokenBoostWeight);
        cfg.mapVoteCooldownMatches = c.getInt("mapVoting.mapCooldownMatches", cfg.mapVoteCooldownMatches);
        cfg.showLiveResults = c.getBoolean("mapVoting.showLiveResults", cfg.showLiveResults);
        cfg.applyWinnerToNextMatch = c.getBoolean("mapVoting.applyWinnerToNextMatch", cfg.applyWinnerToNextMatch);

        cfg.mapRatingsEnabled = c.getBoolean("mapRatings.enabled", cfg.mapRatingsEnabled);
        cfg.promptAfterMatch = c.getBoolean("mapRatings.promptAfterMatch", cfg.promptAfterMatch);
        cfg.ratingWindowSeconds = c.getInt("mapRatings.ratingWindowSeconds", cfg.ratingWindowSeconds);
        cfg.requirePlayedMatch = c.getBoolean("mapRatings.requirePlayedMatch", cfg.requirePlayedMatch);
        cfg.allowFeedback = c.getBoolean("mapRatings.allowFeedback", cfg.allowFeedback);
        cfg.feedbackMaxLength = c.getInt("mapRatings.feedbackMaxLength", cfg.feedbackMaxLength);
        cfg.allowRatingUpdatesDuringWindow = c.getBoolean("mapRatings.allowRatingUpdatesDuringWindow", cfg.allowRatingUpdatesDuringWindow);

        return cfg;
    }
}
