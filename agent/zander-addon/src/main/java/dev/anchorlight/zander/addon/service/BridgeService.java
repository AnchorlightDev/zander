package dev.anchorlight.zander.addon.service;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.Bukkit;
import org.bukkit.scheduler.BukkitRunnable;
import dev.anchorlight.zander.addon.ZanderAddonMain;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public class BridgeService {

    private record BridgeTask(int executorTaskId, String command) {}

    private final ZanderAddonMain plugin;
    private final HttpClient httpClient = HttpClient.newHttpClient();

    public BridgeService(ZanderAddonMain plugin) {
        this.plugin = plugin;
    }

    public void start() {
        new BukkitRunnable() {
            @Override
            public void run() {
                pollAndExecute();
            }
        }.runTaskTimerAsynchronously(plugin, 0L, pollIntervalSeconds() * 20L);
    }

    private void pollAndExecute() {
        List<BridgeTask> tasks;
        try {
            tasks = pollTasks();
        } catch (Exception e) {
            plugin.getLogger().warning("[Bridge] Poll error: " + e.getMessage());
            return;
        }

        if (tasks.isEmpty()) return;

        Bukkit.getScheduler().runTask(plugin, () -> {
            for (BridgeTask task : tasks) {
                String command = task.command().replaceFirst("^/", "");
                try {
                    if (!Bukkit.dispatchCommand(Bukkit.getConsoleSender(), command)) {
                        String reason = "Unknown command or refused by the server";
                        plugin.getLogger().warning("[Bridge] Task " + task.executorTaskId() + " failed: " + reason);
                        CompletableFuture.runAsync(() -> reportTask(task.executorTaskId(), false, reason));
                        continue;
                    }
                    CompletableFuture.runAsync(() -> reportTask(task.executorTaskId(), true, null));
                } catch (Exception e) {
                    String reason = e.getMessage() != null ? e.getMessage() : "Unknown error";
                    plugin.getLogger().warning("[Bridge] Task " + task.executorTaskId() + " failed: " + reason);
                    CompletableFuture.runAsync(() -> reportTask(task.executorTaskId(), false, reason));
                }
            }
        });
    }

    private List<BridgeTask> pollTasks() throws Exception {
        String url = apiBase() + "/api/bridge/processor/get?slug=" + serverSlug() + "&claim=true&limit=50";

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("x-access-token", token())
                .GET()
                .build();

        HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());

        if (res.statusCode() != 200) {
            plugin.getLogger().warning("[Bridge] Poll returned HTTP " + res.statusCode());
            return Collections.emptyList();
        }

        JsonObject json = JsonParser.parseString(res.body()).getAsJsonObject();
        if (!json.get("success").getAsBoolean()) {
            String msg = json.has("message") ? json.get("message").getAsString() : "no message";
            plugin.getLogger().warning("[Bridge] Poll rejected: " + msg);
            return Collections.emptyList();
        }

        JsonArray data = json.getAsJsonArray("data");
        if (data == null || data.isEmpty()) return Collections.emptyList();

        List<BridgeTask> tasks = new ArrayList<>(data.size());
        for (var element : data) {
            JsonObject obj = element.getAsJsonObject();
            tasks.add(new BridgeTask(
                    obj.get("executorTaskId").getAsInt(),
                    obj.get("command").getAsString()
            ));
        }
        return tasks;
    }

    private void reportTask(int taskId, boolean success, String reason) {
        String url = apiBase() + "/api/bridge/processor/task/" + taskId + "/report";

        JsonObject body = new JsonObject();
        body.addProperty("status", success ? "completed" : "failed");
        body.addProperty("result", success ? "Command executed successfully" : (reason != null ? reason : "Unknown error"));
        body.addProperty("executedBy", serverSlug());

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Content-Type", "application/json")
                    .header("x-access-token", token())
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                    .build();

            HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) {
                plugin.getLogger().warning("[Bridge] Report for task " + taskId + " returned HTTP " + res.statusCode());
            }
        } catch (Exception e) {
            plugin.getLogger().warning("[Bridge] Report for task " + taskId + " failed: " + e.getMessage());
        }
    }

    private String apiBase() {
        return ApiUrl.base(plugin);
    }

    /// `bridge.poll-interval-seconds`, falling back to the older `executor-bridge` key.
    private long pollIntervalSeconds() {
        long seconds = plugin.getConfig().getLong("bridge.poll-interval-seconds",
                plugin.getConfig().getLong("executor-bridge.poll-interval-seconds", 4L));
        return Math.max(1L, seconds);
    }

    private String token() {
        return plugin.getConfig().getString("api-key", "");
    }

    private String serverSlug() {
        return plugin.getConfig().getString("server-name", "survival");
    }
}
