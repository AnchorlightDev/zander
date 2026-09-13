package dev.anchorlight.zander.auth.model.user;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.util.Locale;
import java.util.Optional;

/** The API's answer to {@code POST /user/verify}: {@code {"success": bool, "message": string}}. */
public record UserVerifyResult(boolean success, String message) {

    /** Parses a verify response. Empty if the body is not a JSON object with a boolean {@code success}. */
    public static Optional<UserVerifyResult> parse(String body) {
        if (body == null || body.isBlank()) {
            return Optional.empty();
        }
        try {
            JsonElement root = JsonParser.parseString(body);
            if (!root.isJsonObject()) {
                return Optional.empty();
            }
            JsonObject object = root.getAsJsonObject();
            JsonElement success = object.get("success");
            if (success == null || !success.isJsonPrimitive() || !success.getAsJsonPrimitive().isBoolean()) {
                return Optional.empty();
            }
            JsonElement message = object.get("message");
            String text = message != null && message.isJsonPrimitive() ? message.getAsString() : null;
            return Optional.of(new UserVerifyResult(success.getAsBoolean(), text));
        } catch (JsonParseException e) {
            return Optional.empty();
        }
    }

    /**
     * A failure saying the player is already linked. Not really a failure: they simply don't need
     * to be on this auth-only server.
     */
    public boolean alreadyLinked() {
        if (success || message == null) {
            return false;
        }
        String lower = message.toLowerCase(Locale.ROOT);
        return lower.contains("already") && lower.contains("linked");
    }

    /** What to kick the player with. Every outcome kicks: this server only exists to verify. */
    public Component kickMessage() {
        if (success) {
            return Component.text(message != null ? message : "Your account has been linked.", NamedTextColor.GREEN);
        }
        if (alreadyLinked()) {
            return Component.text("You're already linked — no need to be here. You can rejoin the main server.", NamedTextColor.GREEN);
        }
        return Component.text(message != null ? message : "Verification failed.", NamedTextColor.RED);
    }
}
