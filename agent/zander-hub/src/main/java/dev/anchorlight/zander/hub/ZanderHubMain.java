package dev.anchorlight.zander.hub;

import dev.anchorlight.stonelib.config.ConfigUpdater;
import dev.anchorlight.stonelib.region.RegionIndex;
import dev.anchorlight.stonelib.region.RegionTracker;
import dev.anchorlight.stonelib.region.SelectionManager;
import dev.anchorlight.stonelib.region.SelectionWand;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.minimessage.MiniMessage;
import org.bukkit.Bukkit;
import org.bukkit.plugin.PluginManager;
import org.bukkit.plugin.java.JavaPlugin;
import dev.anchorlight.zander.hub.bridge.BridgeClient;
import dev.anchorlight.zander.hub.commands.fly;
import dev.anchorlight.zander.hub.commands.portal.PortalCommand;
import dev.anchorlight.zander.hub.events.HubBoosterPlate;
import dev.anchorlight.zander.hub.events.HubPlayerJoin;
import dev.anchorlight.zander.hub.events.HubPlayerJoinChristmas;
import dev.anchorlight.zander.hub.events.HubPlayerLeave;
import dev.anchorlight.zander.hub.events.HubPlayerVoid;
import dev.anchorlight.zander.hub.gui.HubCompassItem;
import dev.anchorlight.zander.hub.portal.Portal;
import dev.anchorlight.zander.hub.portal.PortalActivationHandler;
import dev.anchorlight.zander.hub.portal.PortalMovementListener;
import dev.anchorlight.zander.hub.portal.PortalRenderer;
import dev.anchorlight.zander.hub.portal.PortalRepository;
import dev.anchorlight.zander.hub.portal.PortalService;
import dev.anchorlight.zander.hub.portal.PortalSessionManager;
import dev.anchorlight.zander.hub.protection.HubCreatureSpawnProtection;
import dev.anchorlight.zander.hub.protection.HubInteractionProtection;
import dev.anchorlight.zander.hub.protection.HubProtection;
import dev.anchorlight.zander.hub.protection.PortalBlockProtection;
import dev.anchorlight.zander.hub.protection.dimension.DimensionProtectionListener;

import java.io.File;

public class ZanderHubMain extends JavaPlugin {
    public static ZanderHubMain plugin;
    public static BridgeClient bridgeClient;
    public static PortalService portalService;
    public static PortalSessionManager portalSessions;
    public static PortalRenderer portalRenderer;

    public void onEnable() {
        plugin = this;

        ConfigUpdater.update(this, "config.yml");
        reloadConfig();
        ConfigUpdater.update(this, "welcome.yml");

        ConfigurationManager.setupHubLocationsConfig();
        ConfigurationManager.setupMessagesConfig();
        ConfigurationManager.setupMiscConfig();
        ConfigurationManager.setupDimensionsConfig();
        ConfigurationManager.setupCompassConfig();
        ConfigurationManager.setupWelcomeFile();

        // Zander proxy bridge
        this.getServer().getMessenger().registerOutgoingPluginChannel(this, "zander:hub");
        bridgeClient = new BridgeClient((player, bytes) -> player.sendPluginMessage(this, "zander:hub", bytes), 1500L);
        this.getServer().getMessenger().registerIncomingPluginChannel(this, "zander:hub",
                (channel, player, message) -> bridgeClient.onPluginMessageReceived(message));

        // Portal system
        File portalsFile = new File(getDataFolder(), "portals.yml");
        PortalRepository portalRepository = new PortalRepository(portalsFile, getLogger(),
                worldName -> Bukkit.getWorld(worldName) != null);
        RegionIndex<Portal> portalIndex = new RegionIndex<>(Portal::region);
        portalService = new PortalService(portalRepository, portalIndex);
        getLogger().info("Loaded " + portalService.all().size() + " portal(s).");

        portalSessions = new PortalSessionManager();
        RegionTracker<Portal> portalTracker = new RegionTracker<>(portalIndex, Portal::id, Portal::enabled);
        PortalActivationHandler activationHandler = new PortalActivationHandler(this, portalSessions, bridgeClient);
        SelectionManager selections = new SelectionManager();
        SelectionWand portalWand = new SelectionWand(this, "portal_wand", selections, (player, corner, point) ->
                player.sendMessage(MiniMessage.miniMessage().deserialize("<yellow>Position " + corner + " set: <white>"
                        + point.world() + " " + point.x() + ", " + point.y() + ", " + point.z() + "</white></yellow>")));
        portalRenderer = new PortalRenderer(portalService, portalIndex);
        portalService.setChangeListener(portalRenderer::apply);
        portalRenderer.renderAll();

        // Init Message
        TextComponent enabledMessage = Component.empty()
                .color(NamedTextColor.GREEN)
                .append(Component.text("\n\nZander Hub has been enabled.\n"))
                .append(Component.text("Running Version " + plugin.getPluginMeta().getVersion() + "\n"))
                .append(Component.text("GitHub Repository: https://github.com/ModularSoftAU/zander\n"))
                .append(Component.text("Created by Modular Software\n\n", NamedTextColor.DARK_PURPLE));
        getServer().sendMessage(enabledMessage);

        // Event Registry
        PluginManager pluginmanager = this.getServer().getPluginManager();
        pluginmanager.registerEvents(new HubPlayerJoin(this), this);
        pluginmanager.registerEvents(new HubPlayerLeave(this), this);
        pluginmanager.registerEvents(new HubPlayerVoid(this), this);
        pluginmanager.registerEvents(new HubBoosterPlate(this), this);
        pluginmanager.registerEvents(new HubPlayerJoinChristmas(this), this);
        // Hub Protection
        pluginmanager.registerEvents(new HubProtection(this), this);
        pluginmanager.registerEvents(new HubInteractionProtection(this), this);
        pluginmanager.registerEvents(new HubCreatureSpawnProtection(this), this);
        pluginmanager.registerEvents(new DimensionProtectionListener(this), this);
        pluginmanager.registerEvents(new PortalBlockProtection(), this);

        // Item Event Registry
        pluginmanager.registerEvents(new HubCompassItem(), this);
        pluginmanager.registerEvents(portalWand, this);
        pluginmanager.registerEvents(new PortalMovementListener(this, portalTracker, portalSessions, activationHandler), this);
        pluginmanager.registerEvents(portalRenderer, this);

        // Command Registry
        this.getCommand("fly").setExecutor(new fly());
        PortalCommand portalCommand = new PortalCommand(portalService, selections, portalWand, portalRenderer);
        this.getCommand("zportal").setExecutor(portalCommand);
        this.getCommand("zportal").setTabCompleter(portalCommand);
    }

    @Override
    public void onDisable() {
        Bukkit.getScheduler().cancelTasks(this);
        if (bridgeClient != null) {
            bridgeClient.cancelAll();
            this.getServer().getMessenger().unregisterIncomingPluginChannel(this, "zander:hub");
            this.getServer().getMessenger().unregisterOutgoingPluginChannel(this, "zander:hub");
        }
        if (portalRenderer != null) {
            portalRenderer.removeAllTints();
        }
        bridgeClient = null;
        portalRenderer = null;
        portalService = null;
        portalSessions = null;
        plugin = null;
    }
}
