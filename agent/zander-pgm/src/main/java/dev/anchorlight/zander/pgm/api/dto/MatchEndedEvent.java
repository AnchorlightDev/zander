package dev.anchorlight.zander.pgm.api.dto;

import java.util.List;
import java.util.Map;

public class MatchEndedEvent extends BridgeEvent {
    public String matchId;
    public String mapKey;
    public String mapName;
    public long endedAt;
    public long durationSeconds;
    public List<String> winners;
    public List<String> losers;
    public List<String> participants;
    public Map<String, Object> objectiveSummary;

    public MatchEndedEvent() {
        super("MATCH_ENDED");
    }
}
