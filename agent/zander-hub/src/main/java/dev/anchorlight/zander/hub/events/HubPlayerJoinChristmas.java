package dev.anchorlight.zander.hub.events;

import dev.anchorlight.zander.hub.ZanderHubMain;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.title.Title;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;

import java.time.Duration;
import java.util.Calendar;
import java.util.Date;

public class HubPlayerJoinChristmas implements Listener {
    ZanderHubMain plugin;

    public HubPlayerJoinChristmas(ZanderHubMain plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();

        if (!isChristmasOccasion()) {
            return;
        }

        // This was previously built with ChatColor, sendTitle(String, ...) and
        // getDisplayName(), all of which are deprecated. The Adventure
        // equivalents were already written out here in comments; this is that
        // code, restored.
        Component titleText = Component.empty()
                .append(Component.text("Merry ", NamedTextColor.GREEN))
                .append(Component.text("Christmas!", NamedTextColor.RED));

        Component subtitleText = Component.empty()
                .append(player.displayName().color(NamedTextColor.GREEN))
                .append(Component.text(" have a very Merry Christmas!", NamedTextColor.RED));

        // Fade in over 500ms, hold for 3s, fade out over 500ms.
        Title.Times times = Title.Times.times(
                Duration.ofMillis(500), Duration.ofMillis(3000), Duration.ofMillis(500));
        player.showTitle(Title.title(titleText, subtitleText, times));

        Component divider = Component.text("============= ", NamedTextColor.WHITE)
                .decorate(TextDecoration.BOLD);

        player.sendMessage(Component.empty()
                .append(divider)
                .append(Component.text("Merry ", NamedTextColor.GREEN).decorate(TextDecoration.BOLD))
                .append(Component.text("Christmas", NamedTextColor.RED).decorate(TextDecoration.BOLD))
                .append(Component.text(" =============", NamedTextColor.WHITE).decorate(TextDecoration.BOLD)));

        player.sendMessage(Component.text("Merry Christmas ")
                .append(player.displayName().color(NamedTextColor.GREEN))
                .append(Component.text("!")));

        player.sendMessage(Component.text(
                "Have a wonderful day with all your friends and family. Remember the reason for the season."));
        player.sendMessage(Component.text(
                "For to us a child is born, to us a son is given, and the government will be on his shoulders. "
                        + "And he will be called Wonderful Counselor, Mighty God, Everlasting Father, Prince of Peace."));
        player.sendMessage(Component.text(
                "Isaiah 9:6 // New International Version (NIV)", NamedTextColor.AQUA));
    }

    public boolean isChristmasOccasion() {
        Calendar calendar = Calendar.getInstance();
        calendar.setTime(new Date());

        int month = calendar.get(Calendar.MONTH);
        int monthplus = month + 1;
        int day = calendar.get(Calendar.DAY_OF_MONTH);

        return monthplus == 12 && day == 24 || monthplus == 12 && day == 25;
    }
}
