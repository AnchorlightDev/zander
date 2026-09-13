package org.modularsoft.zander.waterfall;

import net.md_5.bungee.api.ChatColor;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.plugin.Listener;
import net.md_5.bungee.api.plugin.Plugin;
import org.modularsoft.zander.waterfall.commands.*;
import org.modularsoft.zander.waterfall.events.*;
import org.modularsoft.zander.waterfall.util.announcement.TipChatter;
import org.modularsoft.zander.waterfall.util.api.Heartbeat;

public class ZanderProxyMain extends Plugin implements Listener {
    private static ZanderProxyMain plugin;
    public static ConfigurationManager configurationManager;

    @Override
    public void onEnable() {
        setInstance(this);
        configurationManager.initConfig();

        // Init Message
        getProxy().getConsole().sendMessage(new TextComponent(ChatColor.GREEN + "\n\nZander Proxy has been enabled.\nRunning Version " + plugin.getDescription().getVersion() + "\nGitHub Repository: https://github.com/ModularSoftAU/zander\nCreated by Modular Software\n\n"));

        // Command Registry
        getProxy().getPluginManager().registerCommand(this, new ping());
        getProxy().getPluginManager().registerCommand(this, new rules());
        getProxy().getPluginManager().registerCommand(this, new discord());
        getProxy().getPluginManager().registerCommand(this, new website());
        getProxy().getPluginManager().registerCommand(this, new report());

        // Event Registry
        getProxy().getPluginManager().registerListener(this, new UserChatEvent());
        getProxy().getPluginManager().registerListener(this, new UserOnLogin());
        getProxy().getPluginManager().registerListener(this, new UserOnDisconnect());
        getProxy().getPluginManager().registerListener(this, new UserOnSwitch());
        getProxy().getPluginManager().registerListener(this, new UserOnProxyPing());
        getProxy().getPluginManager().registerListener(this, new UserCommandSpyEvent());
        getProxy().getPluginManager().registerListener(this, new UserSocialSpyEvent());

        // Start the Heartbeat task
        Heartbeat.startHeartbeatTask();

        // Start the Announcement Tip task
        TipChatter.startAnnouncementTipTask();
    }

    @Override
    public void onDisable() {

    }

    public static ZanderProxyMain getInstance() {
        return plugin;
    }

    private static void setInstance(ZanderProxyMain instance) {
        ZanderProxyMain.plugin = instance;
    }
}
