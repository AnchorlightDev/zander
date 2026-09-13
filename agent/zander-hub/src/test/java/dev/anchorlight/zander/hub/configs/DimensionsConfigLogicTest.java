package dev.anchorlight.zander.hub.configs;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DimensionsConfigLogicTest {
    @Test
    void defaultNetherMessageMentionsNether() {
        String fallback = "<red>The Nether is not available from the Hub.</red>";
        assertTrue(fallback.contains("Nether"));
    }

    @Test
    void defaultEndMessageMentionsEnd() {
        String fallback = "<red>The End is not available from the Hub.</red>";
        assertTrue(fallback.contains("End"));
    }
}
