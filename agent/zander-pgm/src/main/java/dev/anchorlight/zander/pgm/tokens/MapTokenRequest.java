package dev.anchorlight.zander.pgm.tokens;

/** A pending Map Token request fetched from zander-web. */
public class MapTokenRequest {
    public String id;
    public String uuid;
    public String username;
    public String mapKey;
    public String action; // NOMINATE, SET_NEXT, SPONSOR
    public int tokenCost;

    public boolean isSetNext() {
        return "SET_NEXT".equalsIgnoreCase(action);
    }

    public boolean isSponsor() {
        return "SPONSOR".equalsIgnoreCase(action);
    }
}
