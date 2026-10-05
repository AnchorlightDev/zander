package dev.anchorlight.zander.auth.events;

import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.server.ServerListPingEvent;

import static dev.anchorlight.zander.auth.ZanderAuthMain.plugin;

public class UserOnServerPing implements Listener {
    @EventHandler
    public void onServerPing(ServerListPingEvent event) {
        String motd = plugin.getConfig().getString("MOTDTopLine");
        if (motd == null) {
            return;
        }

        // setMotd(String) and ChatColor are both deprecated; the Adventure
        // equivalents are motd(Component) and the legacy '&' serializer, which
        // keeps existing &-coded config values working.
        event.motd(LegacyComponentSerializer.legacyAmpersand().deserialize(motd));
    }
}
