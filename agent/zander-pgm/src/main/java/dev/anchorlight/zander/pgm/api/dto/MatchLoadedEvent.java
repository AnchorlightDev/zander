package dev.anchorlight.zander.pgm.api.dto;

import java.util.List;
import java.util.Map;

public class MatchLoadedEvent extends BridgeEvent {
    public String matchId;
    public String mapKey;
    public String mapName;
    public String mapVersion;
    public List<String> mapAuthors;
    public List<String> gamemodes;
    public List<String> teams;
    public List<String> objectives;
    public int maxPlayers;
    public Map<String, Object> metadata;

    public MatchLoadedEvent() {
        super("MATCH_LOADED");
    }
}
