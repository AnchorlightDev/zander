package dev.anchorlight.zander.addon.hologram;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.anchorlight.stonelib.http.ApiClient;
import dev.anchorlight.zander.addon.ZanderAddonMain;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Display;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Interaction;
import org.bukkit.entity.Player;
import org.bukkit.entity.TextDisplay;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.world.ChunkLoadEvent;
import org.bukkit.persistence.PersistentDataType;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** Fetches dashboard frames and renders them at locally persisted world locations. */
public final class HologramManager implements Listener, CommandExecutor, TabCompleter {
    private static final String ADMIN_PERMISSION = "zanderaddon.hologram.admin";
    private static final Pattern VALID_NAME = Pattern.compile("^[A-Za-z0-9_-]{1,32}$");
    private static final LegacyComponentSerializer LEGACY = LegacyComponentSerializer.legacyAmpersand();

    private final ZanderAddonMain plugin;
    private final HologramRepository repository;
    private final NamespacedKey entityKey;
    private final Map<String, PlacedHologram> placed = new LinkedHashMap<>();
    private final Map<String, TextDisplay> displays = new LinkedHashMap<>();
    private final Map<String, Interaction> hitboxes = new LinkedHashMap<>();
    private Map<String, List<HologramFrame>> frames = Map.of();
    private ApiClient api;
    private long rotationIntervalMs;

    public HologramManager(ZanderAddonMain plugin) {
        this.plugin = plugin;
        this.repository = new HologramRepository(new java.io.File(plugin.getDataFolder(), "holograms.yml"), plugin.getLogger());
        this.entityKey = new NamespacedKey(plugin, "hologram_name");
    }

    public void start() {
        placed.putAll(repository.load());
        rotationIntervalMs = Math.max(1, plugin.getConfig().getLong("holograms.rotation-interval-seconds", 5)) * 1000L;
        refreshApiClient();
        placed.values().forEach(this::ensureDisplay);

        long pollSeconds = Math.max(10, plugin.getConfig().getLong("holograms.poll-interval-seconds", 30));
        Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, this::fetchFrames, 1L, pollSeconds * 20L);
        Bukkit.getScheduler().runTaskTimer(plugin, this::renderAll, 20L, 20L);
    }

    private void refreshApiClient() {
        String base = plugin.getConfig().getString("api-url", "").trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        String token = plugin.getConfig().getString("holograms.api-key", "").trim();
        if (token.isBlank()) token = plugin.getConfig().getString("api-key", "").trim();
        if (base.isBlank() || token.isBlank() || token.equalsIgnoreCase("changeme")) {
            api = null;
            plugin.getLogger().warning("Hologram API is not configured. Set api-url and api-key in config.yml.");
            return;
        }
        api = ApiClient.builder(base).header("x-access-token", token).logger(plugin.getLogger()).build();
    }

    private void fetchFrames() {
        ApiClient client = api;
        if (client == null || !plugin.getConfig().getBoolean("holograms.enabled", true)) return;
        client.get("/api/hologram/messages").thenAccept(body -> {
            if (body == null) return;
            try {
                Map<String, List<HologramFrame>> loaded = parseFrames(body);
                Bukkit.getScheduler().runTask(plugin, () -> frames = loaded);
            } catch (RuntimeException e) {
                plugin.getLogger().warning("Could not parse hologram API response: " + e.getMessage());
            }
        });
    }

    private Map<String, List<HologramFrame>> parseFrames(String body) {
        JsonObject root = JsonParser.parseString(body).getAsJsonObject();
        if (!root.has("success") || !root.get("success").getAsBoolean()) {
            throw new IllegalArgumentException("API response reported failure");
        }
        JsonArray data = root.getAsJsonArray("data");
        Map<String, List<HologramFrame>> result = new LinkedHashMap<>();
        for (JsonElement element : data) {
            JsonObject row = element.getAsJsonObject();
            String group = string(row, "group", "default").trim().toLowerCase(Locale.ROOT);
            String message = string(row, "message", "");
            if (group.isEmpty() || message.isEmpty()) continue;
            result.computeIfAbsent(group, ignored -> new ArrayList<>()).add(new HologramFrame(group, message,
                    nullableString(row, "link"), nullableString(row, "countdownTo"),
                    nullableString(row, "countdownFinishedText")));
        }
        result.replaceAll((group, groupFrames) -> List.copyOf(groupFrames));
        return Map.copyOf(result);
    }

    private static String string(JsonObject json, String key, String fallback) {
        return json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : fallback;
    }

    private static String nullableString(JsonObject json, String key) {
        String value = string(json, key, "");
        return value.isBlank() ? null : value;
    }

    private void renderAll() {
        if (!plugin.getConfig().getBoolean("holograms.enabled", true)) {
            for (String name : new ArrayList<>(displays.keySet())) removeDisplay(name);
            return;
        }
        for (PlacedHologram hologram : placed.values()) {
            TextDisplay display = ensureDisplay(hologram);
            if (display == null) continue;
            HologramFrame frame = currentFrame(hologram.group());
            String message = frame == null ? "&7No active messages for &f" + hologram.group() : format(frame);
            display.text(LEGACY.deserialize(message));
        }
    }

    private String format(HologramFrame frame) {
        String message = frame.message();
        Instant target = null;
        if (frame.countdownTo() != null) {
            try {
                target = Instant.parse(frame.countdownTo());
            } catch (RuntimeException ignored) {
                // Keep the frame's original text if the API contains a malformed timestamp.
            }
        }
        if (target == null) return message;
        Duration remaining = Duration.between(Instant.now(), target);
        long seconds = Math.max(0, remaining.getSeconds());
        long days = seconds / 86400;
        long hours = (seconds % 86400) / 3600;
        long minutes = (seconds % 3600) / 60;
        long secs = seconds % 60;
        if (remaining.isNegative()) {
            if (frame.countdownFinishedText() != null) return frame.countdownFinishedText();
            days = hours = minutes = secs = 0;
        }
        return message.replace("{countdown}", days + "d " + hours + "h " + minutes + "m " + secs + "s")
                .replace("{days}", Long.toString(days)).replace("{hours}", Long.toString(hours))
                .replace("{minutes}", Long.toString(minutes)).replace("{seconds}", Long.toString(secs));
    }

    private HologramFrame currentFrame(String group) {
        List<HologramFrame> groupFrames = frames.get(group.toLowerCase(Locale.ROOT));
        if (groupFrames == null || groupFrames.isEmpty()) return null;
        int index = (int) ((System.currentTimeMillis() / rotationIntervalMs) % groupFrames.size());
        return groupFrames.get(index);
    }

    private TextDisplay ensureDisplay(PlacedHologram hologram) {
        if (!plugin.getConfig().getBoolean("holograms.enabled", true)) return null;
        Location location = hologram.location();
        World world = location.getWorld();
        if (world == null || !world.isChunkLoaded(location.getBlockX() >> 4, location.getBlockZ() >> 4)) return null;
        String key = hologram.name().toLowerCase(Locale.ROOT);
        TextDisplay current = displays.get(key);
        if (current != null && current.isValid()) {
            ensureHitbox(key, location, world);
            return current;
        }
        TextDisplay display = current;
        if (display == null || !display.isValid()) {
            display = world.spawn(location, TextDisplay.class, text -> {
                text.setPersistent(false);
                text.setBillboard(Display.Billboard.CENTER);
                text.setDisplayWidth(1.5f);
                text.setDisplayHeight(0.5f);
                text.setShadowed(true);
                text.setSeeThrough(true);
                text.setDefaultBackground(false);
                text.setAlignment(TextDisplay.TextAlignment.CENTER);
                text.setLineWidth(320);
            });
            displays.put(key, display);
        }
        ensureHitbox(key, location, world);
        return display;
    }

    private void ensureHitbox(String key, Location location, World world) {
        Interaction current = hitboxes.get(key);
        if (current != null && current.isValid()) return;
        Interaction hitbox = world.spawn(location.clone().subtract(0, 0.35, 0), Interaction.class, entity -> {
            entity.setPersistent(false);
            entity.setInteractionWidth(1.6f);
            entity.setInteractionHeight(0.8f);
            entity.setResponsive(true);
            entity.getPersistentDataContainer().set(entityKey, PersistentDataType.STRING, key);
        });
        hitboxes.put(key, hitbox);
    }

    private void removeDisplay(String name) {
        String key = name.toLowerCase(Locale.ROOT);
        TextDisplay display = displays.remove(key);
        if (display != null && display.isValid()) display.remove();
        Interaction hitbox = hitboxes.remove(key);
        if (hitbox != null && hitbox.isValid()) hitbox.remove();
    }

    private void persist() {
        repository.save(placed.values());
    }

    private boolean allowed(CommandSender sender) {
        if (sender.hasPermission(ADMIN_PERMISSION)) return true;
        sender.sendMessage(Component.text("You do not have permission to manage holograms.", NamedTextColor.RED));
        return false;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!allowed(sender)) return true;
        if (args.length == 0) {
            sender.sendMessage(Component.text("Usage: /hologram <create|delete|list|move|reload> [name] [group]", NamedTextColor.YELLOW));
            return true;
        }
        switch (args[0].toLowerCase(Locale.ROOT)) {
            case "create" -> create(sender, args);
            case "delete", "remove" -> delete(sender, args);
            case "move", "setlocation" -> move(sender, args);
            case "list" -> list(sender);
            case "reload" -> {
                refreshApiClient();
                fetchFrames();
                sender.sendMessage(Component.text("Requested a refresh from the hologram API.", NamedTextColor.GREEN));
            }
            default -> sender.sendMessage(Component.text("Unknown hologram action. Use /hologram for help.", NamedTextColor.RED));
        }
        return true;
    }

    private void create(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("Only a player can place a hologram. Stand where it should appear.", NamedTextColor.RED));
            return;
        }
        if (args.length < 3 || !VALID_NAME.matcher(args[1]).matches()) {
            sender.sendMessage(Component.text("Usage: /hologram create <name> <group>", NamedTextColor.YELLOW));
            return;
        }
        String key = args[1].toLowerCase(Locale.ROOT);
        if (placed.containsKey(key)) {
            sender.sendMessage(Component.text("A hologram named '" + args[1] + "' already exists.", NamedTextColor.RED));
            return;
        }
        String group = String.join(" ", java.util.Arrays.copyOfRange(args, 2, args.length)).trim().toLowerCase(Locale.ROOT);
        if (group.length() > 64) {
            sender.sendMessage(Component.text("The group name must be 64 characters or fewer.", NamedTextColor.RED));
            return;
        }
        Location anchor = player.getLocation().clone().add(0, 2.2, 0);
        PlacedHologram hologram = new PlacedHologram(args[1], group, anchor);
        placed.put(key, hologram);
        persist();
        ensureDisplay(hologram);
        sender.sendMessage(Component.text("Placed hologram '" + args[1] + "' for group '" + group + "'.", NamedTextColor.GREEN));
    }

    private void delete(CommandSender sender, String[] args) {
        if (args.length != 2) {
            sender.sendMessage(Component.text("Usage: /hologram delete <name>", NamedTextColor.YELLOW));
            return;
        }
        String key = args[1].toLowerCase(Locale.ROOT);
        if (placed.remove(key) == null) {
            sender.sendMessage(Component.text("No hologram named '" + args[1] + "'.", NamedTextColor.RED));
            return;
        }
        removeDisplay(key);
        persist();
        sender.sendMessage(Component.text("Deleted hologram '" + args[1] + "'.", NamedTextColor.GREEN));
    }

    private void move(CommandSender sender, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("Only a player can move a hologram.", NamedTextColor.RED));
            return;
        }
        if (args.length != 2) {
            sender.sendMessage(Component.text("Usage: /hologram move <name> (stand at the new location first)", NamedTextColor.YELLOW));
            return;
        }
        String key = args[1].toLowerCase(Locale.ROOT);
        PlacedHologram old = placed.get(key);
        if (old == null) {
            sender.sendMessage(Component.text("No hologram named '" + args[1] + "'.", NamedTextColor.RED));
            return;
        }
        removeDisplay(key);
        PlacedHologram moved = new PlacedHologram(old.name(), old.group(), player.getLocation().clone().add(0, 2.2, 0));
        placed.put(key, moved);
        persist();
        ensureDisplay(moved);
        sender.sendMessage(Component.text("Moved hologram '" + old.name() + "'.", NamedTextColor.GREEN));
    }

    private void list(CommandSender sender) {
        if (placed.isEmpty()) {
            sender.sendMessage(Component.text("No holograms are placed. Use /hologram create <name> <group>.", NamedTextColor.GRAY));
            return;
        }
        sender.sendMessage(Component.text("Placed holograms:", NamedTextColor.GOLD));
        placed.values().stream().sorted(Comparator.comparing(PlacedHologram::name, String.CASE_INSENSITIVE_ORDER))
                .forEach(h -> sender.sendMessage(Component.text("• " + h.name() + " — group " + h.group() + " — "
                        + h.location().getWorld().getName() + " " + h.location().getBlockX() + " "
                        + h.location().getBlockY() + " " + h.location().getBlockZ(), NamedTextColor.GRAY)));
    }

    @EventHandler
    public void onChunkLoad(ChunkLoadEvent event) {
        for (PlacedHologram hologram : placed.values()) {
            Location location = hologram.location();
            if (location.getWorld().equals(event.getWorld()) && location.getBlockX() >> 4 == event.getChunk().getX()
                    && location.getBlockZ() >> 4 == event.getChunk().getZ()) ensureDisplay(hologram);
        }
    }

    @EventHandler
    public void onDisplayInteract(PlayerInteractEntityEvent event) {
        Entity entity = event.getRightClicked();
        String name = entity.getPersistentDataContainer().get(entityKey, PersistentDataType.STRING);
        if (name == null) return;
        PlacedHologram hologram = placed.get(name.toLowerCase(Locale.ROOT));
        HologramFrame frame = hologram == null ? null : currentFrame(hologram.group());
        if (frame == null || frame.link() == null) return;
        try {
            URI uri = URI.create(frame.link());
            if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) return;
            event.getPlayer().sendMessage(Component.text("Open link: ", NamedTextColor.GRAY)
                    .append(Component.text(frame.link(), NamedTextColor.AQUA)
                            .clickEvent(ClickEvent.openUrl(frame.link()))));
        } catch (IllegalArgumentException ignored) {
            // Invalid links are ignored rather than sent to clients.
        }
    }

    public void stop() {
        for (String name : new ArrayList<>(displays.keySet())) removeDisplay(name);
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (!sender.hasPermission(ADMIN_PERMISSION)) return List.of();
        if (args.length == 1) return List.of("create", "delete", "list", "move", "reload").stream()
                .filter(s -> s.startsWith(args[0].toLowerCase(Locale.ROOT))).toList();
        if (args.length == 2 && List.of("delete", "move").contains(args[0].toLowerCase(Locale.ROOT))) {
            return placed.values().stream().map(PlacedHologram::name).filter(s -> s.toLowerCase(Locale.ROOT)
                    .startsWith(args[1].toLowerCase(Locale.ROOT))).toList();
        }
        if (args.length == 3 && args[0].equalsIgnoreCase("create")) {
            return frames.keySet().stream().filter(s -> s.startsWith(args[2].toLowerCase(Locale.ROOT))).toList();
        }
        return List.of();
    }
}
