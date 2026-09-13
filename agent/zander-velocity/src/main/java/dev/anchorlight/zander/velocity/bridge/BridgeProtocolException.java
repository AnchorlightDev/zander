package dev.anchorlight.zander.velocity.bridge;

/** Thrown when a `zander:hub` bridge message can't be safely encoded or decoded. */
public class BridgeProtocolException extends RuntimeException {
    public BridgeProtocolException(String message) {
        super(message);
    }

    public BridgeProtocolException(String message, Throwable cause) {
        super(message, cause);
    }
}
