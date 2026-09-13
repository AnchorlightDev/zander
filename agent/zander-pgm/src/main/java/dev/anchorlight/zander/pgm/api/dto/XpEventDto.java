package dev.anchorlight.zander.pgm.api.dto;

public class XpEventDto extends BridgeEvent {
    public String uuid;
    public String username;
    public String reason;
    public int amount;
    public long totalXp;
    public int level;
    public boolean levelUp;
    public String matchId;

    public XpEventDto() {
        super("XP_EVENT");
    }
}
