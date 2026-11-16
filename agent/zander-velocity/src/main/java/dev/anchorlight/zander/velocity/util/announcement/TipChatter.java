package dev.anchorlight.zander.velocity.util.announcement;

import com.jayway.jsonpath.JsonPath;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.velocitypowered.api.proxy.server.RegisteredServer;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public class TipChatter {

    // Initialize the logger
    private static final Logger logger = LoggerFactory.getLogger(TipChatter.class);

    public static void startAnnouncementTipTask() {
        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));
        String announcementTipPrefix = ZanderVelocityMain.getConfig().getString(Route.from("announcementTipPrefix"));
        int interval = ZanderVelocityMain.getConfig().getInt(Route.from("announcementTipInterval"));

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            // Tips can be targeted at specific servers, so fetch one tip per
            // server that has players and send it only to that server's players.
            for (RegisteredServer server : ZanderVelocityMain.getProxy().getAllServers()) {
                if (server.getPlayersConnected().isEmpty()) {
                    continue;
                }
                String serverName = server.getServerInfo().getName();
                try {
                    Request req = Request.builder()
                            .setURL(BaseAPIURL + "/announcement/get?announcementType=tip&server="
                                    + URLEncoder.encode(serverName, StandardCharsets.UTF_8))
                            .setMethod(Request.Method.GET)
                            .addHeader("x-access-token", APIKey)
                            .build();

                    Response res = req.execute();
                    String json = res.getBody();

                    // $.data[0] is a definite path, so it throws rather than
                    // returning empty when no tip is active. Read the list first
                    // and skip quietly if there is nothing for this server.
                    List<Map<String, Object>> tips = JsonPath.read(json, "$.data[*]");
                    if (tips == null || tips.isEmpty()) {
                        continue;
                    }

                    Object rawFormat = tips.get(0).get("colourMessageFormat");
                    if (rawFormat == null) {
                        continue;
                    }

                    String colourMessageFormat = String.valueOf(rawFormat);
                    Object rawLink = tips.get(0).get("link");
                    String link = rawLink == null ? null : String.valueOf(rawLink);

                    Component message = LegacyComponentSerializer.legacy('&')
                            .deserialize(announcementTipPrefix + " " + colourMessageFormat);
                    if (link != null && !link.isEmpty()) {
                        // Ensure the link starts with a protocol
                        String finalLink = link;
                        if (!link.startsWith("http://") && !link.startsWith("https://")) {
                            finalLink = "https://" + link;
                        }
                        message = message.clickEvent(ClickEvent.openUrl(finalLink));
                    }

                    final Component toSend = message;
                    server.getPlayersConnected().forEach(player -> player.sendMessage(toSend));
                } catch (Exception e) {
                    logger.error("Announcement Tip failed for server " + serverName + ", will try again later.", e);
                }
            }
        }).repeat(interval, TimeUnit.MINUTES).schedule();
    }
}