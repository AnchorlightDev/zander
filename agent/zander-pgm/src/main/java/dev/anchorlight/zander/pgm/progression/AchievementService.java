package dev.anchorlight.zander.pgm.progression;

import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.api.dto.AchievementEventDto;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Evaluates achievement definitions against live player stats and emits
 * ACHIEVEMENT_UNLOCKED events. Definitions are seeded in {@link #registerDefaults()}
 * and can be extended by adding {@link AchievementDefinition}s.
 */
public class AchievementService {

    private final ZanderPGMConfig config;
    private final ZanderApiClient api;
    private final XpService xpService;

    private final List<AchievementDefinition> definitions = new ArrayList<>();
    private final ConcurrentHashMap<UUID, AchievementProgress> progress = new ConcurrentHashMap<>();

    public AchievementService(ZanderPGMConfig config, ZanderApiClient api, XpService xpService) {
        this.config = config;
        this.api = api;
        this.xpService = xpService;
        registerDefaults();
    }

    public void register(AchievementDefinition def) {
        definitions.add(def);
    }

    private void registerDefaults() {
        register(new AchievementDefinition("FIRST_BLOOD", "First Blood", "Get first blood in a match",
                s -> s.firstBloods >= 1));
        register(new AchievementDefinition("FIRST_WIN", "First Win", "Win your first match",
                s -> s.wins >= 1));
        register(new AchievementDefinition("TEN_KILLS", "Ten Kills", "Get 10 total kills",
                s -> s.kills >= 10));
        register(new AchievementDefinition("WOOL_RUNNER", "Wool Runner", "Capture a wool",
                s -> s.woolCaptures >= 1));
        register(new AchievementDefinition("FLAG_BEARER", "Flag Bearer", "Capture a flag",
                s -> s.flagCaptures >= 1));
        register(new AchievementDefinition("CORE_BREAKER", "Core Breaker", "Leak a core",
                s -> s.coreLeaks >= 1));
        register(new AchievementDefinition("STREAK_5", "Killing Spree", "Get a 5 killstreak",
                s -> s.bestKillstreak >= 5));
        register(new AchievementDefinition("STREAK_10", "Unstoppable", "Get a 10 killstreak",
                s -> s.bestKillstreak >= 10));
        register(new AchievementDefinition("SHARPSHOOTER", "Sharpshooter", "High bow accuracy with 20+ shots",
                s -> s.bowShots >= 20 && s.bowAccuracy >= 0.6));
        register(new AchievementDefinition("OBJECTIVE_PLAYER", "Objective Player", "Capture multiple objectives",
                s -> s.objectivesCaptured >= 3));
    }

    /** Evaluate all definitions for the player and unlock any newly satisfied. */
    public void evaluate(PlayerStats stats, String matchId) {
        if (!config.feature("achievements") || stats == null || stats.uuid == null) {
            return;
        }
        stats.recomputeBowAccuracy();
        UUID uuid = UUID.fromString(stats.uuid);
        AchievementProgress prog = progress.computeIfAbsent(uuid, AchievementProgress::new);

        for (AchievementDefinition def : definitions) {
            if (prog.hasUnlocked(def.id)) {
                continue;
            }
            if (def.isSatisfied(stats) && prog.unlock(def.id)) {
                stats.achievementsUnlocked++;
                emit(stats, def, matchId);
                xpService.award(stats, XpService.Reason.ACHIEVEMENT, matchId);
            }
        }
    }

    private void emit(PlayerStats stats, AchievementDefinition def, String matchId) {
        AchievementEventDto dto = new AchievementEventDto();
        dto.uuid = stats.uuid;
        dto.username = stats.username;
        dto.achievementId = def.id;
        dto.achievementName = def.name;
        dto.description = def.description;
        dto.matchId = matchId;
        api.send(dto);
        api.achievement(dto);
    }

    public void clear() {
        progress.clear();
    }
}
