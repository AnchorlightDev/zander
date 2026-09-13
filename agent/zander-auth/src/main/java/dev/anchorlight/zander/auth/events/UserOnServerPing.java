package dev.anchorlight.zander.auth.events;

import org.bukkit.ChatColor;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.server.ServerListPingEvent;

import static dev.anchorlight.zander.auth.ZanderAuthMain.plugin;

public class UserOnServerPing implements Listener {
    @EventHandler
    public void onServerPing(ServerListPingEvent event) {
        String motd = plugin.getConfig().getString("MOTDTopLine");
        event.setMotd(ChatColor.translateAlternateColorCodes('&', motd));
    }
}
