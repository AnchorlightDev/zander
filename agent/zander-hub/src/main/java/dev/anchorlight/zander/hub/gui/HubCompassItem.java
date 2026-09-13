package dev.anchorlight.zander.hub.gui;

import dev.anchorlight.stonelib.menu.SlotLayout;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.minimessage.MiniMessage;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import dev.anchorlight.zander.hub.ConfigurationManager;
import dev.anchorlight.zander.hub.ZanderHubMain;
import dev.anchorlight.zander.hub.bridge.BridgeMessage;
import dev.anchorlight.zander.hub.configs.CompassConfig.CompassServerEntry;
import dev.anchorlight.zander.hub.items.NavigationCompassItem;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class HubCompassItem implements Listener {
    private static final NamespacedKey SERVER_ID_KEY = new NamespacedKey(ZanderHubMain.plugin, "compass_server_id");
    private static final MiniMessage MM = MiniMessage.miniMessage();

    private final Map<UUID, Boolean> pendingConnect = new ConcurrentHashMap<>();
    private final Map<UUID, Long> lastOpenAttempt = new ConcurrentHashMap<>();

    private static class CompassInventoryHolder implements InventoryHolder {
        private Inventory inventory;

        @Override
        public Inventory getInventory() {
            return inventory;
        }
    }

    @EventHandler
    public void onPlayerInteract(PlayerInteractEvent event) {
        if (event.getHand() == EquipmentSlot.OFF_HAND) {
            return; // avoid double-open from main+off hand events on the same physical click
        }

        Player player = event.getPlayer();
        if (!NavigationCompassItem.isNavigationCompass(player.getInventory().getItemInMainHand())) {
            return;
        }

        boolean rightClickOpens = ZanderHubMain.plugin.getConfig().getBoolean("compass.open-on.right-click", true);
        boolean leftClickOpens = ZanderHubMain.plugin.getConfig().getBoolean("compass.open-on.left-click", false);
        boolean isRightClick = event.getAction() == Action.RIGHT_CLICK_AIR || event.getAction() == Action.RIGHT_CLICK_BLOCK;
        boolean isLeftClick = event.getAction() == Action.LEFT_CLICK_AIR || event.getAction() == Action.LEFT_CLICK_BLOCK;

        if ((isRightClick && !rightClickOpens) || (isLeftClick && !leftClickOpens) || (!isRightClick && !isLeftClick)) {
            return;
        }

        event.setCancelled(true);

        UUID playerId = player.getUniqueId();
        long now = System.currentTimeMillis();
        Long last = lastOpenAttempt.get(playerId);
        if (last != null && now - last < 250L) {
            return; // dedupe double PlayerInteractEvent firing for one physical click
        }
        lastOpenAttempt.put(playerId, now);

        openCompassGui(player);
    }

    public void openCompassGui(Player player) {
        CompassInventoryHolder holder = new CompassInventoryHolder();
        String title = ZanderHubMain.plugin.getConfig().getString("compass.title", "<dark_aqua>Server Selector</dark_aqua>");
        Inventory inventory = Bukkit.createInventory(holder, 9, MM.deserialize(title));
        holder.inventory = inventory;
        renderLoading(inventory, ConfigurationManager.getCompass().getServers());
        player.openInventory(inventory);

        ZanderHubMain.bridgeClient.requestServerList(player)
                .whenComplete((response, error) -> Bukkit.getScheduler().runTask(ZanderHubMain.plugin, () -> {
                    if (!player.isOnline() || player.getOpenInventory().getTopInventory().getHolder() != holder) {
                        return; // player closed/changed inventory, or went offline, before the response arrived
                    }
                    if (error != null || response == null) {
                        renderUnavailable(inventory, ConfigurationManager.getCompass().getServers());
                        return;
                    }
                    renderServers(inventory, ConfigurationManager.getCompass().getServers(), response);
                }));
    }

    private void renderLoading(Inventory inventory, List<CompassServerEntry> configured) {
        Map<String, Integer> explicitSlots = explicitSlots(configured);
        List<String> ids = configured.stream().map(CompassServerEntry::id).toList();
        for (SlotLayout.Assignment assignment : SlotLayout.assign(ids, explicitSlots, inventory.getSize())) {
            CompassServerEntry entry = configured.stream().filter(e -> e.id().equals(assignment.entryId())).findFirst().orElseThrow();
            inventory.setItem(assignment.slot(), loadingIcon(entry));
        }
    }

    private ItemStack loadingIcon(CompassServerEntry entry) {
        ItemStack item = new ItemStack(Material.GRAY_DYE);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text(entry.display(), NamedTextColor.GRAY));
        meta.lore(List.of(Component.text("Loading...", NamedTextColor.DARK_GRAY)));
        item.setItemMeta(meta);
        return item;
    }

    private void renderUnavailable(Inventory inventory, List<CompassServerEntry> configured) {
        inventory.clear();
        Map<String, Integer> explicitSlots = explicitSlots(configured);
        List<String> ids = configured.stream().map(CompassServerEntry::id).toList();
        for (SlotLayout.Assignment assignment : SlotLayout.assign(ids, explicitSlots, inventory.getSize())) {
            CompassServerEntry entry = configured.stream().filter(e -> e.id().equals(assignment.entryId())).findFirst().orElseThrow();
            inventory.setItem(assignment.slot(), buildIcon(entry, "UNAVAILABLE", null));
        }
    }

    private void renderServers(Inventory inventory, List<CompassServerEntry> configured, BridgeMessage.ServerListResponse response) {
        inventory.clear();
        Map<String, BridgeMessage.ServerInfo> byId = new HashMap<>();
        for (BridgeMessage.ServerInfo info : response.servers()) {
            byId.put(info.id(), info);
        }
        boolean hideInaccessible = ZanderHubMain.plugin.getConfig().getBoolean("compass.hide-inaccessible", true);

        List<String> visibleIds = new ArrayList<>();
        for (CompassServerEntry entry : configured) {
            BridgeMessage.ServerInfo info = byId.get(entry.id());
            boolean hasAccess = info != null && info.hasAccess();
            if (!hasAccess && hideInaccessible) {
                continue;
            }
            visibleIds.add(entry.id());
        }

        Map<String, Integer> explicitSlots = explicitSlots(configured);
        for (SlotLayout.Assignment assignment : SlotLayout.assign(visibleIds, explicitSlots, inventory.getSize())) {
            CompassServerEntry entry = configured.stream().filter(e -> e.id().equals(assignment.entryId())).findFirst().orElseThrow();
            BridgeMessage.ServerInfo info = byId.get(entry.id());
            String state = resolveState(info);
            inventory.setItem(assignment.slot(), buildIcon(entry, state, info));
        }
    }

    private Map<String, Integer> explicitSlots(List<CompassServerEntry> configured) {
        return Map.of(); // CompassConfig doesn't yet expose per-server explicit slots; all entries are centred.
    }

    private String resolveState(BridgeMessage.ServerInfo info) {
        if (info == null || !info.registered()) {
            return "UNAVAILABLE";
        }
        if (info.alreadyConnected()) {
            return "ALREADY_CONNECTED";
        }
        if (!info.hasAccess()) {
            return "NO_ACCESS";
        }
        return "ONLINE";
    }

    private ItemStack buildIcon(CompassServerEntry entry, String state, BridgeMessage.ServerInfo info) {
        boolean locked = state.equals("NO_ACCESS") || state.equals("UNAVAILABLE");
        Material material = locked
                ? org.bukkit.Material.matchMaterial(
                        ZanderHubMain.plugin.getConfig().getString("compass.locked-icon.material", "BARRIER"))
                : entry.material();
        if (material == null) {
            material = Material.BARRIER;
        }

        ItemStack item = new ItemStack(material);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text(entry.display(), locked ? NamedTextColor.RED : NamedTextColor.WHITE));

        List<Component> lore = new ArrayList<>();
        if (locked && state.equals("NO_ACCESS")) {
            lore.add(MM.deserialize(ZanderHubMain.plugin.getConfig().getString(
                    "compass.locked-icon.lore", "<red>You do not have access to this server.</red>")));
        } else {
            lore.add(Component.text(entry.lore(), NamedTextColor.WHITE));
        }
        lore.add(switch (state) {
            case "ALREADY_CONNECTED" -> Component.text("You are already connected.", NamedTextColor.GRAY);
            case "UNAVAILABLE" -> Component.text("Currently unavailable.", NamedTextColor.GRAY);
            default -> Component.text("Players online: " + (info != null ? info.playerCount() : 0), NamedTextColor.GRAY);
        });
        meta.lore(lore);

        if (!locked && !state.equals("ALREADY_CONNECTED")) {
            meta.getPersistentDataContainer().set(SERVER_ID_KEY, PersistentDataType.STRING, entry.id());
        }
        item.setItemMeta(meta);
        return item;
    }

    @EventHandler
    public void onClick(InventoryClickEvent event) {
        if (!(event.getInventory().getHolder() instanceof CompassInventoryHolder)) {
            return;
        }
        event.setCancelled(true); // prevents movement, shift-click, and collection into this GUI

        ItemStack clicked = event.getCurrentItem();
        if (clicked == null || !clicked.hasItemMeta()) {
            return;
        }
        String serverId = clicked.getItemMeta().getPersistentDataContainer().get(SERVER_ID_KEY, PersistentDataType.STRING);
        if (serverId == null) {
            return;
        }

        Player player = (Player) event.getWhoClicked();
        UUID playerId = player.getUniqueId();
        if (Boolean.TRUE.equals(pendingConnect.putIfAbsent(playerId, true))) {
            return; // a connection request is already in flight, ignore repeated clicks
        }

        player.closeInventory();
        ZanderHubMain.bridgeClient.sendConnectRequest(player, "", serverId)
                .whenComplete((response, error) -> Bukkit.getScheduler().runTask(ZanderHubMain.plugin, () -> {
                    pendingConnect.remove(playerId);
                    if (!player.isOnline()) {
                        return;
                    }
                    if (error != null) {
                        player.sendMessage(MM.deserialize("<red>Failed to connect, please try again.</red>"));
                        return;
                    }
                    switch (response) {
                        case BridgeMessage.ConnectStarted ignored ->
                                player.sendMessage(MM.deserialize("<yellow>Connecting you now...</yellow>"));
                        case BridgeMessage.ConnectDenied denied ->
                                player.sendMessage(MM.deserialize("<red>" + denied.reason() + "</red>"));
                        case BridgeMessage.ConnectFailed failed ->
                                player.sendMessage(MM.deserialize("<red>" + failed.reason() + "</red>"));
                        default -> { }
                    }
                }));
    }

    @EventHandler
    public void onDrag(InventoryDragEvent event) {
        if (event.getInventory().getHolder() instanceof CompassInventoryHolder) {
            event.setCancelled(true);
        }
    }
}
