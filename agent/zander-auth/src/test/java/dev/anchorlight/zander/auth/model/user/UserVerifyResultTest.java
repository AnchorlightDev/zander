package dev.anchorlight.zander.auth.model.user;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class UserVerifyResultTest {

    @Test
    void parsesSuccessAndMessage() {
        UserVerifyResult result = UserVerifyResult.parse("{\"success\":true,\"message\":\"Linked!\"}").orElseThrow();
        assertTrue(result.success());
        assertEquals("Linked!", result.message());
        assertEquals(Component.text("Linked!", NamedTextColor.GREEN), result.kickMessage());
    }

    @Test
    void missingMessageFallsBackInsteadOfShowingNull() {
        assertEquals(Component.text("Verification failed.", NamedTextColor.RED),
                UserVerifyResult.parse("{\"success\":false}").orElseThrow().kickMessage());
        assertEquals(Component.text("Your account has been linked.", NamedTextColor.GREEN),
                UserVerifyResult.parse("{\"success\":true,\"message\":null}").orElseThrow().kickMessage());
    }

    @Test
    void alreadyLinkedFailureIsShownAsGreen() {
        UserVerifyResult result = UserVerifyResult.parse("{\"success\":false,\"message\":\"This account is Already LINKED\"}").orElseThrow();
        assertTrue(result.alreadyLinked());
        assertEquals(NamedTextColor.GREEN, result.kickMessage().color());
    }

    @Test
    void otherFailureShowsApiMessageInRed() {
        UserVerifyResult result = UserVerifyResult.parse("{\"success\":false,\"message\":\"Invalid code\"}").orElseThrow();
        assertFalse(result.alreadyLinked());
        assertEquals(Component.text("Invalid code", NamedTextColor.RED), result.kickMessage());
    }

    @Test
    void unexpectedBodiesAreEmpty() {
        assertEquals(Optional.empty(), UserVerifyResult.parse(null));
        assertEquals(Optional.empty(), UserVerifyResult.parse(""));
        assertEquals(Optional.empty(), UserVerifyResult.parse("<html>502 Bad Gateway</html>"));
        assertEquals(Optional.empty(), UserVerifyResult.parse("[1,2]"));
        assertEquals(Optional.empty(), UserVerifyResult.parse("{\"message\":\"no success field\"}"));
        assertEquals(Optional.empty(), UserVerifyResult.parse("{\"success\":\"yes\"}"));
    }
}
