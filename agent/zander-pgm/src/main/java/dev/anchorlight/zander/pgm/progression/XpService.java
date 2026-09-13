package dev.anchorlight.zander.pgm.progression;

import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.api.dto.XpEventDto;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

/**
 * Awards configurable XP for gameplay events, keeps {@link PlayerStats#level} in
 * sync via {@link LevelService}, and emits XP events (with level-up flag) to
 * zander-web.
 */
public class XpService {

    public enum Reason {WIN, LOSS, KILL, ASSIST, FIRST_BLOOD, OBJECTIVE_CAPTURE, OBJECTIVE_DEFEND, KILLSTREAK, PARTICIPATION, ACHIEVEMENT}

    private final ZanderPGMConfig config;
    private final ZanderApiClient api;
    private final LevelService levels;

    public XpService(ZanderPGMConfig config, ZanderApiClient api, LevelService levels) {
        this.config = config;
        this.api = api;
        this.levels = levels;
    }

    private int amountFor(Reason reason) {
        return switch (reason) {
            case WIN -> config.xpWin;
            case LOSS -> config.xpLoss;
            case KILL -> config.xpKill;
            case ASSIST -> config.xpAssist;
            case FIRST_BLOOD -> config.xpFirstBlood;
            case OBJECTIVE_CAPTURE -> config.xpObjectiveCapture;
            case OBJECTIVE_DEFEND -> config.xpObjectiveDefend;
            case KILLSTREAK -> config.xpKillstreakBonus;
            case PARTICIPATION -> config.xpLoss; // participation ~ loss baseline
            case ACHIEVEMENT -> config.xpFirstBlood;
        };
    }

    /** Award XP for a reason to a player and emit an XP event. */
    public void award(PlayerStats stats, Reason reason, String matchId) {
        award(stats, reason, amountFor(reason), matchId);
    }

    public void award(PlayerStats stats, Reason reason, int amount, String matchId) {
        if (!config.feature("xp") || stats == null || amount <= 0) {
            return;
        }
        int previousLevel = stats.level;
        stats.xpEarned += amount;
        if (config.feature("levels")) {
            stats.level = levels.levelForXp(stats.xpEarned);
        }

        XpEventDto dto = new XpEventDto();
        dto.uuid = stats.uuid;
        dto.username = stats.username;
        dto.reason = reason.name();
        dto.amount = amount;
        dto.totalXp = stats.xpEarned;
        dto.level = stats.level;
        dto.levelUp = stats.level > previousLevel;
        dto.matchId = matchId;
        api.send(dto);
        api.xp(dto);
    }
}
