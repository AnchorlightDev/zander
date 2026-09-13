package dev.anchorlight.zander.pgm.api.dto;

public class AchievementEventDto extends BridgeEvent {
    public String uuid;
    public String username;
    public String achievementId;
    public String achievementName;
    public String description;
    public String matchId;

    public AchievementEventDto() {
        super("ACHIEVEMENT_UNLOCKED");
    }
}
