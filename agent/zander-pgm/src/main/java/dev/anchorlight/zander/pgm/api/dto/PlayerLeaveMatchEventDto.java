package dev.anchorlight.zander.pgm.api.dto;

public class PlayerLeaveMatchEventDto extends BridgeEvent {
    public String matchId;
    public String uuid;
    public String username;
    public String team;
    public long sessionSeconds;

    public PlayerLeaveMatchEventDto() {
        super("PLAYER_LEAVE_MATCH");
    }
}
