package dev.anchorlight.zander.velocity.commands;

import com.jayway.jsonpath.JsonPath;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;

/**
 * /link — get a 6-digit code to link this Minecraft account to the website /
 * Discord, without having to join the dedicated auth-only verification server.
 *
 * Calls the same POST /user/verify endpoint the auth server uses and prints
 * the returned code straight into chat. The auth server join-and-kick flow
 * still exists as a fallback for banned players who cannot reach the network.
 */
public class link implements SimpleCommand {
    @Override
    public void execute(final Invocation invocation) {
        CommandSource source = invocation.source();

        if (!(source instanceof Player)) {
            source.sendMessage(Component.text("Only players can use this command.").color(NamedTextColor.RED));
            return;
        }

        Player player = (Player) source;
        String baseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String apiKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            try {
                String body = "{\"username\":\"" + player.getUsername()
                        + "\",\"uuid\":\"" + player.getUniqueId().toString() + "\"}";

                Request req = Request.builder()
                        .setURL(baseAPIURL + "/user/verify")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", apiKey)
                        .addHeader("Content-Type", "application/json")
                        .setRequestBody(body)
                        .build();

                Response res = req.execute();
                String json = res.getBody();
                boolean success = JsonPath.read(json, "$.success");
                String message = JsonPath.read(json, "$.message");

                if (success) {
                    player.sendMessage(Component.text(message).color(NamedTextColor.GREEN));
                    player.sendMessage(Component.text("Enter this code on the website to finish linking. It expires in 5 minutes — run /link again for a new one.")
                            .color(NamedTextColor.YELLOW));
                } else {
                    // e.g. already linked, or not yet in the player base.
                    player.sendMessage(Component.text(message).color(NamedTextColor.RED));
                }
            } catch (Exception e) {
                player.sendMessage(Component.text("An error has occurred. Is the API down?").color(NamedTextColor.RED));
                ZanderVelocityMain.getLogger().error("Error generating link code for " + player.getUsername(), e);
            }
        }).schedule();
    }
}
