package dev.anchorlight.zander.velocity.util.api;

import com.jayway.jsonpath.JsonPath;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;

import java.util.concurrent.TimeUnit;

public class Heartbeat {
    public static void startHeartbeatTask() {
        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            try {
                // Your existing code here
                // GET request to link to rules.
                Request req = Request.builder()
                        .setURL(BaseAPIURL + "/heartbeat")
                        .setMethod(Request.Method.GET)
                        .addHeader("x-access-token", APIKey)
                        .build();

                Response res = req.execute();
                String json = res.getBody();
                Boolean heartbeat = JsonPath.read(json, "$.success");

                // Check if the heartbeat is not successful
                if (!heartbeat) {
                    // Kick all players
                    ZanderVelocityMain.getProxy().getAllPlayers().forEach(player -> {
                        Component message = Component.text("API Heartbeat Failed, the server is temporarily offline.")
                                .color(NamedTextColor.RED);
                        player.disconnect(message);
                    });
                }
            } catch (Exception e) {
                ZanderVelocityMain.getLogger().error("API Heartbeat Failed, kicking all players until back online.", e);

                // Kick all players
                ZanderVelocityMain.getProxy().getAllPlayers().forEach(player -> {
                    Component message = Component.text("API Heartbeat Failed, the server is temporarily offline.")
                            .color(NamedTextColor.RED);
                    player.disconnect(message);
                });
            }
        }).repeat(60, TimeUnit.SECONDS).schedule();
    }
}