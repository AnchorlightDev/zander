package dev.anchorlight.zander.hub.utils;

import de.myzelyam.api.vanish.VanishAPI;
import org.bukkit.entity.Player;

/// Isolates references to the PremiumVanish API so its class is only resolved
/// when the plugin is confirmed enabled. Referencing `VanishAPI` directly from
/// a class that's always loaded triggers `NoClassDefFoundError` at JVM
/// bytecode verification time, even behind a runtime presence check.
public final class PremiumVanishBridge {
    private PremiumVanishBridge() {}

    public static void reloadConfig() {
        VanishAPI.reloadConfig();
    }

    public static boolean isInvisible(Player player) {
        return VanishAPI.isInvisible(player);
    }
}
