package dev.anchorlight.zander.hub.portal;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PortalIdValidatorTest {
    @Test
    void acceptsLettersNumbersHyphensUnderscores() {
        assertTrue(PortalIdValidator.isValid("survival-1_test"));
    }

    @Test
    void rejectsSpaces() {
        assertFalse(PortalIdValidator.isValid("my portal"));
    }

    @Test
    void rejectsEmpty() {
        assertFalse(PortalIdValidator.isValid(""));
    }

    @Test
    void rejectsNull() {
        assertFalse(PortalIdValidator.isValid(null));
    }

    @Test
    void rejectsSpecialCharacters() {
        assertFalse(PortalIdValidator.isValid("portal!"));
        assertFalse(PortalIdValidator.isValid("portal/../etc"));
    }

    @Test
    void normaliseLowerCases() {
        assertEquals("survival", PortalIdValidator.normalise("Survival"));
        assertEquals("survival", PortalIdValidator.normalise("SURVIVAL"));
    }

    @Test
    void caseInsensitiveDuplicatesNormaliseToSameKey() {
        assertEquals(PortalIdValidator.normalise("VipLounge"), PortalIdValidator.normalise("viplounge"));
    }
}
