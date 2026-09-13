package dev.anchorlight.zander.pgm.api.dto;

import java.util.HashMap;
import java.util.Map;

/** Generic objective event covering wool/flag/core/destroyable/control-point. */
public class ObjectiveEventDto extends BridgeEvent {
    public String objectiveType;
    public String objectiveId;
    public String objectiveName;
    public String uuid;
    public String username;
    public String team;
    public String action;
    public Double value;
    public String matchId;
    public String mapKey;
    public String mapName;
    public Map<String, Object> raw = new HashMap<>();

    public ObjectiveEventDto() {
        super("OBJECTIVE_EVENT");
    }
}
