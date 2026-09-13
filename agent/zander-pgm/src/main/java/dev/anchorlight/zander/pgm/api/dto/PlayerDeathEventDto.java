package dev.anchorlight.zander.pgm.api.dto;

public class PlayerDeathEventDto extends BridgeEvent {
    public String matchId;
    public String mapKey;
    public String mapName;

    public String victimUuid;
    public String victimName;
    public String killerUuid;
    public String killerName;
    public String assisterUuid;
    public String assisterName;

    public String cause;
    public String weapon;
    public Double distance;
    public boolean teamKill;

    public PlayerDeathEventDto() {
        super("PLAYER_DEATH");
    }
}
