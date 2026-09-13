package org.modularsoft.zander.waterfall.util.announcement;

import com.jayway.jsonpath.JsonPath;
import io.github.ModularEnigma.Request;
import io.github.ModularEnigma.Response;
import net.md_5.bungee.api.ChatColor;
import net.md_5.bungee.api.ProxyServer;
import net.md_5.bungee.api.chat.ClickEvent;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.connection.ProxiedPlayer;
import org.modularsoft.zander.waterfall.ConfigurationManager;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class TipChatter {
    public static void startAnnouncementTipTask() {
        // Create a ScheduledExecutorService with a single thread
        ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(1);

        // Schedule the task to run every 10 seconds
        scheduler.scheduleAtFixedRate(() -> {
            try {
                // GET request to fetch Announcement Tip.
                Request req = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/announcement/get?announcementType=tip")
                        .setMethod(Request.Method.GET)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .build();

                Response res = req.execute();
                String json = res.getBody();

                String colourMessageFormat = JsonPath.read(json, "$.data[0].colourMessageFormat");
                String link = JsonPath.read(json, "$.data[0].link");

                // Broadcast the message to all online players
                for (ProxiedPlayer player : ProxyServer.getInstance().getPlayers()) {
                    // Send the message to each player
                    TextComponent message = new TextComponent(ChatColor.translateAlternateColorCodes('&', String.valueOf(ConfigurationManager.getConfig().get("announcementTipPrefix"))) + ChatColor.translateAlternateColorCodes('&', colourMessageFormat));
                    if (link != null && !link.isEmpty()) {
                        // Set the click event only if link is true
                        message.setClickEvent(new ClickEvent(ClickEvent.Action.OPEN_URL, link));
                    }
                    player.sendMessage(message);
                }

            } catch (Exception e) {
                // Handle exceptions here
                e.printStackTrace();
                System.out.println("Announcement Tip Failed, will try again in " + ConfigurationManager.getConfig().getInt("announcementTipInterval") + " minutes.");
            }
        }, 0, ConfigurationManager.getConfig().getInt("announcementTipInterval"), TimeUnit.MINUTES);
    }
}
