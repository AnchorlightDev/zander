package dev.anchorlight.zander.addon.service;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitRunnable;
import dev.anchorlight.zander.addon.ZanderAddonMain;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.*;
import java.util.concurrent.*;

public class StoreCommandService {

    private record PendingCommand(int id, String command, String executeAs) {}
    private record FailedCommand(int id, String reason) {}

    private final ZanderAddonMain plugin;
    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final Gson gson = new Gson();

    // Prevents concurrent claim calls for the same player UUID
    private final Set<UUID> claimsInFlight = ConcurrentHashMap.newKeySet();

    public StoreCommandService(ZanderAddonMain plugin) {
        this.plugin = plugin;
    }

    public void start() {
        // Periodic fallback: re-claim for all currently online players every 5 minutes
        new BukkitRunnable() {
            @Override
            public void run() {
                String serverSlug = serverSlug();
                for (Player player : Bukkit.getOnlinePlayers()) {
                    claimAndExecute(player.getUniqueId(), player.getName(), serverSlug);
                }
            }
        }.runTaskTimerAsynchronously(plugin, 300 * 20L, 300 * 20L);
    }

    public void onPlayerJoin(UUID playerUuid, String playerName) {
        CompletableFuture.runAsync(() -> claimAndExecute(playerUuid, playerName, serverSlug()));
    }

    private void claimAndExecute(UUID playerUuid, String playerName, String serverSlug) {
        if (!claimsInFlight.add(playerUuid)) return; // already in flight for this player

        try {
            List<PendingCommand> commands = claim(playerUuid, playerName, serverSlug);
            if (commands.isEmpty()) return;

            List<Integer> successIds = new ArrayList<>();
            List<FailedCommand> failures = new ArrayList<>();
            CountDownLatch latch = new CountDownLatch(commands.size());

            for (PendingCommand cmd : commands) {
                boolean asPlayer = "player".equalsIgnoreCase(cmd.executeAs()) || "self".equalsIgnoreCase(cmd.executeAs());
                // Player-targeted commands run 1 tick later so the player is fully online
                long delay = asPlayer ? 1L : 0L;

                Bukkit.getScheduler().runTaskLater(plugin, () -> {
                    try {
                        String command = cmd.command().replaceFirst("^/", "");
                        if (asPlayer) {
                            Player p = Bukkit.getPlayer(playerUuid);
                            if (p != null && p.isOnline()) {
                                dispatch(p, cmd, command, successIds, failures);
                            } else {
                                failures.add(new FailedCommand(cmd.id(), "Player offline during dispatch"));
                            }
                        } else {
                            dispatch(Bukkit.getConsoleSender(), cmd, command, successIds, failures);
                        }
                    } catch (Exception e) {
                        String reason = e.getMessage() != null ? e.getMessage() : "Unknown error";
                        plugin.getLogger().warning("[CommandBridge] Command " + cmd.id() + " failed: " + reason);
                        failures.add(new FailedCommand(cmd.id(), reason));
                    } finally {
                        latch.countDown();
                    }
                }, delay);
            }

            // Wait for all dispatched commands to finish before reporting
            try {
                latch.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }

            CompletableFuture.runAsync(() -> {
                if (!successIds.isEmpty()) reportCompleted(playerUuid, successIds);
                if (!failures.isEmpty()) reportFailed(playerUuid, failures);
            });

        } catch (Exception e) {
            plugin.getLogger().warning("[CommandBridge] Claim failed for " + playerName + ": " + e.getMessage());
        } finally {
            claimsInFlight.remove(playerUuid);
        }
    }

    private void dispatch(org.bukkit.command.CommandSender sender, PendingCommand cmd, String command,
                          List<Integer> successIds, List<FailedCommand> failures) {
        if (Bukkit.dispatchCommand(sender, command)) {
            successIds.add(cmd.id());
        } else {
            failures.add(new FailedCommand(cmd.id(), "Unknown command or refused by the server"));
        }
    }

    private List<PendingCommand> claim(UUID playerUuid, String playerName, String serverSlug) throws Exception {
        JsonObject body = new JsonObject();
        body.addProperty("playerUuid", playerUuid.toString());
        body.addProperty("playerName", playerName);
        body.addProperty("serverName", serverSlug);

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(apiBase() + "/api/command-bridge/claim"))
                .header("Content-Type", "application/json")
                .header("x-access-token", token())
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body)))
                .build();

        HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());

        if (res.statusCode() != 200) {
            plugin.getLogger().warning("[CommandBridge] Claim returned HTTP " + res.statusCode() + " for " + playerName);
            return Collections.emptyList();
        }

        JsonObject json = JsonParser.parseString(res.body()).getAsJsonObject();
        if (!json.get("success").getAsBoolean()) return Collections.emptyList();

        JsonArray arr = json.getAsJsonArray("commands");
        if (arr == null || arr.isEmpty()) return Collections.emptyList();

        List<PendingCommand> commands = new ArrayList<>(arr.size());
        for (var element : arr) {
            JsonObject cmd = element.getAsJsonObject();
            int id = cmd.get("id").getAsInt();
            String command = cmd.get("command").getAsString();
            String executeAs = cmd.has("executeAs") ? cmd.get("executeAs").getAsString() : "console";
            commands.add(new PendingCommand(id, command, executeAs));
        }
        return commands;
    }

    private void reportCompleted(UUID playerUuid, List<Integer> ids) {
        try {
            JsonObject body = new JsonObject();
            body.addProperty("playerUuid", playerUuid.toString());
            JsonArray arr = new JsonArray();
            ids.forEach(arr::add);
            body.add("completedCommandIds", arr);
            post(apiBase() + "/api/command-bridge/complete", body);
        } catch (Exception e) {
            plugin.getLogger().warning("[CommandBridge] Complete report failed: " + e.getMessage());
        }
    }

    private void reportFailed(UUID playerUuid, List<FailedCommand> failures) {
        try {
            JsonObject body = new JsonObject();
            body.addProperty("playerUuid", playerUuid.toString());
            JsonArray arr = new JsonArray();
            for (FailedCommand f : failures) {
                JsonObject entry = new JsonObject();
                entry.addProperty("id", f.id());
                entry.addProperty("reason", f.reason() != null ? f.reason() : "Unknown error");
                arr.add(entry);
            }
            body.add("failed", arr);
            post(apiBase() + "/api/command-bridge/fail", body);
        } catch (Exception e) {
            plugin.getLogger().warning("[CommandBridge] Fail report failed: " + e.getMessage());
        }
    }

    private void post(String url, JsonObject body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .header("x-access-token", token())
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body)))
                .build();
        HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) {
            plugin.getLogger().warning("[CommandBridge] POST " + url + " returned HTTP " + res.statusCode());
        }
    }

    private String apiBase() {
        return ApiUrl.base(plugin);
    }

    private String token() {
        return plugin.getConfig().getString("api-key", "");
    }

    private String serverSlug() {
        return plugin.getConfig().getString("server-name", "survival");
    }
}
