package dev.anchorlight.zander.velocity.util.api;

import com.jayway.jsonpath.JsonPath;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class Heartbeat {
    // A single failed beat (web deploy restart, DNS blip, timeout) must not
    // kick the whole network; only a sustained outage does.
    static final int FAILURE_THRESHOLD = 3;
    private static final AtomicInteger consecutiveFailures = new AtomicInteger();

    public static void startHeartbeatTask() {
        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            try {
                Request req = Request.builder()
                        .setURL(BaseAPIURL + "/heartbeat")
                        .setMethod(Request.Method.GET)
                        .addHeader("x-access-token", APIKey)
                        .build();

                Response res = req.execute();
                String json = res.getBody();
                Boolean heartbeat = JsonPath.read(json, "$.success");

                if (Boolean.TRUE.equals(heartbeat)) {
                    consecutiveFailures.set(0);
                } else {
                    recordFailure("API Heartbeat returned success=false.", null);
                }
            } catch (Exception e) {
                recordFailure("API Heartbeat request failed.", e);
            }
        }).repeat(60, TimeUnit.SECONDS).schedule();
    }

    private static void recordFailure(String reason, Exception e) {
        int failures = consecutiveFailures.incrementAndGet();
        if (!shouldKick(failures)) {
            ZanderVelocityMain.getLogger().warn("{} ({}/{} consecutive failures before kicking players)",
                    reason, failures, FAILURE_THRESHOLD, e);
            return;
        }

        ZanderVelocityMain.getLogger().error("{} {} consecutive failures, kicking all players until back online.",
                reason, failures, e);
        ZanderVelocityMain.getProxy().getAllPlayers().forEach(player -> {
            Component message = Component.text("API Heartbeat Failed, the server is temporarily offline.")
                    .color(NamedTextColor.RED);
            player.disconnect(message);
        });
    }

    static boolean shouldKick(int consecutiveFailures) {
        return consecutiveFailures >= FAILURE_THRESHOLD;
    }
}