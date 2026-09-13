package dev.anchorlight.zander.pgm.api.dto;

public class ServerHeartbeatEvent extends BridgeEvent {
    public String displayName;
    public String environment;
    public int onlinePlayers;
    public int maxPlayers;
    public String currentMatchId;
    public String currentMapKey;
    public int queuedEvents;

    public ServerHeartbeatEvent() {
        super("HEARTBEAT");
    }
}
