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
            try {
                // GET request to fetch Announcement Tip.
                Request req = Request.builder()
                        .setURL(BaseAPIURL + "/announcement/get?announcementType=tip")
                        .setMethod(Request.Method.GET)
                        .addHeader("x-access-token", APIKey)
                        .build();

                Response res = req.execute();
                String json = res.getBody();

                String colourMessageFormat = JsonPath.read(json, "$.data[0].colourMessageFormat");
                String link = JsonPath.read(json, "$.data[0].link");

                // Broadcast the message to all online players
                ZanderVelocityMain.getProxy().getAllPlayers().forEach(player -> {
                    // Send the message to each player
                    char translate = '&';
                    Component message = LegacyComponentSerializer.legacy(translate).deserialize(announcementTipPrefix + " " + colourMessageFormat);

                    if (link != null && !link.isEmpty()) {
                        // Ensure the link starts with a protocol
                        String finalLink = link;
                        if (!link.startsWith("http://") && !link.startsWith("https://")) {
                            finalLink = "https://" + link;
                        }
                        // Set the click event and reassign the modified message to the variable
                        message = message.clickEvent(ClickEvent.openUrl(finalLink));
                    }
                    player.sendMessage(message);
                });
            } catch (Exception e) {
                // Handle exceptions here
                logger.error("Announcement Tip Failed, will try again later.", e);
            }
        }).repeat(interval, TimeUnit.MINUTES).schedule();
    }
}