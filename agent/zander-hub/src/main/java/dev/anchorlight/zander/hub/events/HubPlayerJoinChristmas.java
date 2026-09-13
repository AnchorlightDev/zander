package dev.anchorlight.zander.hub.events;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.title.Title;
import org.bukkit.Bukkit;
import dev.anchorlight.zander.hub.ZanderHubMain;
import org.bukkit.ChatColor;
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

        if (isChristmasOccasion()) {
            // Send player a title to their screen.
//            Component christmasTitleText = Component.empty()
//                    .append(Component.text("Merry ", NamedTextColor.GREEN))
//                    .append(Component.text("Christmas!", NamedTextColor.RED))
//                    .append(player.name()
//                            .color(NamedTextColor.RED))
//                    .append(Component.text(" have a very Merry Christmas!", NamedTextColor.RED));

            // Using the times object this title will use 500ms to fade in, stay on screen for 1500ms and then fade out for 500ms
//            final Title.Times times = Title.Times.times(Duration.ofMillis(500), Duration.ofMillis(1500), Duration.ofMillis(500));
//            final Title title = Title.title(christmasTitleText, Component.empty(), times);
//            player.showTitle(title);
            player.sendTitle(ChatColor.GREEN + "Merry " + ChatColor.RED + "Christmas!", player.getDisplayName() + " have a very Merry Christmas!", 10, 60, 10);


//            player.sendMessage(Component.empty()
//                    .decorate(TextDecoration.BOLD)
//                    .append(Component.text("============= ", NamedTextColor.WHITE))
//                    .append(Component.text("Merry ", NamedTextColor.GREEN))
//                    .append(Component.text("Christmas ", NamedTextColor.GREEN))
//                    .append(Component.text("============= ", NamedTextColor.WHITE)));
//
//            player.sendMessage(Component.empty()
//                    .append(Component.text("Merry Christmas "))
//                    .append(player.name().color(NamedTextColor.GREEN))
//                    .append(Component.text("!")));
//
//            player.sendMessage(Component.text("Have a wonderful day with all your friends and family. Remember the reason for the season."));
//            player.sendMessage(Component.text("For to us a child is born, to us a son is given, and the government will be on his shoulders. And he will be called Wonderful Counselor, Mighty God, Everlasting Father, Prince of Peace."));
//            player.sendMessage(Component.text("Have a wonderful day with all your friends and family. Remember the reason for the season.")
//                    .color(NamedTextColor.AQUA));

            // Send player a message to their chat.
            player.sendMessage(ChatColor.WHITE + ChatColor.BOLD.toString() + "============= " + ChatColor.GREEN + ChatColor.BOLD.toString()+ "Merry " + ChatColor.RED + ChatColor.BOLD.toString() + "Christmas" + ChatColor.WHITE + ChatColor.BOLD.toString() + " =============");
            player.sendMessage("Merry Christmas " + ChatColor.GREEN + player.getDisplayName() + "!");
            player.sendMessage("Have a wonderful day with all your friends and family. Remember the reason for the season.");
            player.sendMessage("For to us a child is born, to us a son is given, and the government will be on his shoulders. And he will be called Wonderful Counselor, Mighty God, Everlasting Father, Prince of Peace.");
            player.sendMessage(ChatColor.AQUA + "Isaiah 9:6 // New International Version (NIV)");
        }
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
