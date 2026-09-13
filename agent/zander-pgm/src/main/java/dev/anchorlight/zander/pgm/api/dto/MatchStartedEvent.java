package dev.anchorlight.zander.pgm.api.dto;

import java.util.List;
import java.util.Map;

public class MatchStartedEvent extends BridgeEvent {
    public String matchId;
    public String mapKey;
    public String mapName;
    public long startedAt;
    public List<String> participants;
    public List<String> teams;
    public Map<String, Object> initialObjectiveState;

    public MatchStartedEvent() {
        super("MATCH_STARTED");
    }
}
