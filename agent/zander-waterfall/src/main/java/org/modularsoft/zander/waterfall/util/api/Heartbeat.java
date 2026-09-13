package org.modularsoft.zander.waterfall.util.api;

import com.jayway.jsonpath.JsonPath;
import io.github.ModularEnigma.Request;
import io.github.ModularEnigma.Response;
import net.md_5.bungee.api.ProxyServer;
import org.modularsoft.zander.waterfall.ConfigurationManager;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class Heartbeat {
    public static void startHeartbeatTask() {
        // Create a ScheduledExecutorService with a single thread
        ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(1);

        // Schedule the task to run every 60 seconds
        scheduler.scheduleAtFixedRate(() -> {
            try {
                // Your existing code here
                // GET request to link to rules.
                Request req = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/heartbeat")
                        .setMethod(Request.Method.GET)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .build();

                Response res = req.execute();
                String json = res.getBody();
                Boolean heartbeat = JsonPath.read(json, "$.success");
                System.out.println("API Heartbeat Success");

                // Check if the heartbeat is not successful
                if (!heartbeat) {
                    // Kick all players
                    ProxyServer.getInstance().getPlayers().forEach(player -> {
                        player.disconnect("API Heartbeat Failed, the server is temporarily offline.");
                    });
                }
            } catch (Exception e) {
                // Handle exceptions here
                e.printStackTrace();

                System.out.println("API Heartbeat Failed, kicking all players until back online.");

                // Kick all players
                ProxyServer.getInstance().getPlayers().forEach(player -> {
                    player.disconnect("API Heartbeat Failed, the server is temporarily offline.");
                });
            }
        }, 0, 60, TimeUnit.SECONDS);
    }
}
