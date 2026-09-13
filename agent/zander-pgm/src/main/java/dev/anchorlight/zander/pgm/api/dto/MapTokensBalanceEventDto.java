package dev.anchorlight.zander.pgm.api.dto;

/** Balance-change event emitted for the Mixed Map Token ledger. */
public class MapTokensBalanceEventDto extends BridgeEvent {

    public String playerUuid;
    public String username;
    public String transactionType;
    public int amount;
    public int previousBalance;
    public int newBalance;
    public String reason;
    public String actor;
    public String source;
    public String createdAt;

    public MapTokensBalanceEventDto(String type) {
        super(type);
    }
}
