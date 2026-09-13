package dev.anchorlight.zander.pgm.api.dto;

public class PlayerJoinMatchEventDto extends BridgeEvent {
    public String matchId;
    public String uuid;
    public String username;
    public String team;

    public PlayerJoinMatchEventDto() {
        super("PLAYER_JOIN_MATCH");
    }
}
