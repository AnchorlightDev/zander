package dev.anchorlight.zander.addon;

import lombok.Getter;
import org.bukkit.plugin.java.JavaPlugin;
import dev.anchorlight.zander.addon.commands.FreezeCommand;
import dev.anchorlight.zander.addon.commands.PolicyCommand;
import dev.anchorlight.zander.addon.commands.SocialCommand;
import dev.anchorlight.zander.addon.events.FreezeEvents;
import dev.anchorlight.zander.addon.events.PlayerEvents;
import dev.anchorlight.zander.addon.events.StoreCommandEvents;
import dev.anchorlight.zander.addon.gui.PolicyGUI;
import dev.anchorlight.zander.addon.gui.SocialGUI;
import dev.anchorlight.zander.addon.service.BridgeService;
import dev.anchorlight.zander.addon.service.FreezeService;
import dev.anchorlight.zander.addon.service.PolicyService;
import dev.anchorlight.zander.addon.service.StoreCommandService;

public class ZanderAddonMain extends JavaPlugin {
    @Getter
    private static ZanderAddonMain instance;
    @Getter
    private PolicyService policyService;
    @Getter
    private FreezeService freezeService;
    @Getter
    private StoreCommandService storeCommandService;
    @Getter
    private BridgeService bridgeService;

    @Override
    public void onEnable() {
        instance = this;

        saveDefaultConfig();

        this.policyService = new PolicyService(this);
        this.freezeService = new FreezeService();
        this.storeCommandService = new StoreCommandService(this);
        this.bridgeService = new BridgeService(this);

        PolicyGUI policyGUI = new PolicyGUI(this);
        SocialGUI socialGUI = new SocialGUI(this);
        getServer().getPluginManager().registerEvents(policyGUI, this);
        getServer().getPluginManager().registerEvents(socialGUI, this);
        getServer().getPluginManager().registerEvents(new PlayerEvents(this, policyGUI, socialGUI), this);
        getServer().getPluginManager().registerEvents(new FreezeEvents(freezeService), this);

        if (getConfig().getBoolean("command-bridge.enabled", true)) {
            storeCommandService.start();
            getServer().getPluginManager().registerEvents(new StoreCommandEvents(storeCommandService), this);
            getLogger().info("Command bridge enabled for server: " + getConfig().getString("server-name", "survival"));
        }

        if (getConfig().getBoolean("bridge.enabled", true)) {
            bridgeService.start();
            getLogger().info("Bridge processor enabled for server: " + getConfig().getString("server-name", "survival"));
        }

        getCommand("policy").setExecutor(new PolicyCommand(this, policyService));
        getCommand("social").setExecutor(new SocialCommand(this, socialGUI));
        getCommand("freeze").setExecutor(new FreezeCommand(freezeService));

        getLogger().info("Zander Addon has been enabled.");
    }

    @Override
    public void onDisable() {
        getLogger().info("Zander Addon has been disabled.");
    }
}
