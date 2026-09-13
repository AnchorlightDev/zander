package dev.anchorlight.zander.velocity.events;

import com.jayway.jsonpath.JsonPath;
import com.velocitypowered.api.event.PostOrder;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyPingEvent;
import com.velocitypowered.api.proxy.server.ServerPing.Builder;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import org.slf4j.Logger;

import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

public class UserOnProxyPing {

    private static final Logger logger = ZanderVelocityMain.getLogger();

    private final ZanderVelocityMain plugin;
    private volatile List<Component> cachedMotds = List.of();

    public UserOnProxyPing(ZanderVelocityMain plugin) {
        this.plugin = plugin;
        ZanderVelocityMain.getProxy().getEventManager().register(plugin, this);

        // Fetch MOTD immediately, then refresh every 60 seconds
        ZanderVelocityMain.getProxy().getScheduler()
                .buildTask(plugin, this::refreshMotd)
                .repeat(60, TimeUnit.SECONDS)
                .schedule();
    }

    private void refreshMotd() {
        try {
            String baseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
            String apiKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

            Request req = Request.builder()
                    .setURL(baseAPIURL + "/announcement/get?announcementType=motd")
                    .setMethod(Request.Method.GET)
                    .addHeader("x-access-token", apiKey)
                    .build();

            Response res = req.execute();
            String json = res.getBody();

            List<String> formats = JsonPath.read(json, "$.data[*].colourMessageFormat");
            String motdTopLine = ZanderVelocityMain.getConfig().getString(Route.from("announcementMOTDTopLine"));
            LegacyComponentSerializer serializer = LegacyComponentSerializer.builder().character('&').build();
            cachedMotds = formats.stream()
                    .map(fmt -> (Component) serializer.deserialize(motdTopLine + "\n" + fmt))
                    .toList();
        } catch (Exception e) {
            logger.error("Failed to refresh MOTD from API", e);
        }
    }

    @Subscribe(order = PostOrder.FIRST)
    public void onProxyPingEvent(ProxyPingEvent event) {
        Builder pingBuilder = event.getPing().asBuilder();

        List<Component> motds = cachedMotds;
        if (!motds.isEmpty()) {
            int index = motds.size() == 1 ? 0 : ThreadLocalRandom.current().nextInt(motds.size());
            pingBuilder.description(motds.get(index));
        } else {
            String motdTopLine = ZanderVelocityMain.getConfig().getString(Route.from("announcementMOTDTopLine"));
            Component fallback = LegacyComponentSerializer.builder()
                    .character('&')
                    .build()
                    .deserialize(motdTopLine + "\n" + "&3&lPowered by Zander");
            pingBuilder.description(fallback);
        }

        event.setPing(pingBuilder.build());
    }
}
