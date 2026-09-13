package dev.anchorlight.zander.pgm.tokens;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;
import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.util.JsonUtil;
import dev.anchorlight.zander.pgm.util.SafeLogger;

/**
 * Periodically polls zander-web for pending Map Token requests and dispatches
 * them to {@link MapTokenService}. Polling runs async; the service hops to the
 * main thread for validation.
 */
public class MapTokenRequestPoller {

    private final Plugin plugin;
    private final ZanderApiClient api;
    private final MapTokenService service;
    private final SafeLogger logger;
    private BukkitTask task;

    public MapTokenRequestPoller(Plugin plugin, ZanderApiClient api, MapTokenService service, SafeLogger logger) {
        this.plugin = plugin;
        this.api = api;
        this.service = service;
        this.logger = logger;
    }

    public void start(int intervalSeconds) {
        stop();
        long ticks = Math.max(1, intervalSeconds) * 20L;
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, this::poll, ticks, ticks);
    }

    private void poll() {
        api.pendingMapTokenRequests().thenAccept(body -> {
            if (body == null || body.isBlank()) {
                return;
            }
            try {
                JsonArray arr = JsonUtil.gson().fromJson(body, JsonArray.class);
                if (arr == null) {
                    return;
                }
                for (JsonElement el : arr) {
                    MapTokenRequest req = JsonUtil.gson().fromJson(el, MapTokenRequest.class);
                    if (req != null) {
                        service.handle(req);
                    }
                }
            } catch (Exception e) {
                logger.debug("Failed to parse pending map token requests: " + e.getMessage());
            }
        });
    }

    public void stop() {
        if (task != null) {
            task.cancel();
            task = null;
        }
    }
}
