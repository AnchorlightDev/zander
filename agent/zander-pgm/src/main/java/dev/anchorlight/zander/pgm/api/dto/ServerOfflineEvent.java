package dev.anchorlight.zander.pgm.api.dto;

public class ServerOfflineEvent extends BridgeEvent {
    public String reason;

    public ServerOfflineEvent() {
        super("SERVER_OFFLINE");
    }
}
