package dev.anchorlight.zander.auth.events;

import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import dev.anchorlight.zander.auth.ZanderAuthMain;
import dev.anchorlight.zander.auth.model.user.UserAuth;
import dev.anchorlight.zander.auth.model.user.UserVerifyResult;

import java.util.concurrent.TimeUnit;
import java.util.logging.Level;

public class AuthPlayerJoin implements Listener {
    private static final long REQUEST_TIMEOUT_SECONDS = 15;
    private static final Component API_ERROR = Component.text("An error has occurred. Is the API down?", NamedTextColor.RED);

    ZanderAuthMain plugin;
    public AuthPlayerJoin(ZanderAuthMain plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();

        //
        // Send a user verification request. It runs off the main thread so a slow or
        // unreachable API never freezes the server; the kick is scheduled back onto it.
        //
        UserAuth authUser = UserAuth.builder()
                .uuid(player.getUniqueId())
                .username(player.getName())
                .build();

        try {
            Request.builder()
                    .setURL(plugin.getConfig().getString("BaseAPIURL") + "/user/verify")
                    .setMethod(Request.Method.POST)
                    .addHeader("x-access-token", String.valueOf(plugin.getConfig().getString("APIKey")))
                    .setRequestBody(authUser.toString())
                    .build()
                    .executeAsync()
                    .orTimeout(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                    .whenComplete((response, error) -> {
                        Component reason = kickReason(player, response, error);
                        if (plugin.isEnabled()) {
                            plugin.getServer().getScheduler().runTask(plugin, () -> {
                                if (player.isOnline()) {
                                    player.kick(reason);
                                }
                            });
                        }
                    });
        } catch (RuntimeException e) {
            plugin.getLogger().log(Level.SEVERE, "Could not send verify request for " + player.getName() + ". Check BaseAPIURL in config.yml.", e);
            player.kick(API_ERROR);
        }
    }

    private Component kickReason(Player player, Response response, Throwable error) {
        if (error != null) {
            plugin.getLogger().warning("Verify request for " + player.getName() + " failed: " + error);
            return API_ERROR;
        }

        return UserVerifyResult.parse(response.getBody())
                .map(result -> {
                    plugin.getLogger().info("Verify " + player.getName() + ": success=" + result.success() + ", message=" + result.message());
                    return result.kickMessage();
                })
                .orElseGet(() -> {
                    plugin.getLogger().warning("Unexpected verify response for " + player.getName()
                            + " (HTTP " + response.getStatusCode() + "): " + response.getBody());
                    return API_ERROR;
                });
    }
}
