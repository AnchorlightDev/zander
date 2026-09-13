package dev.anchorlight.zander.velocity;

import com.google.inject.Inject;
import com.velocitypowered.api.command.CommandManager;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.plugin.Dependency;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.plugin.PluginContainer;
import com.velocitypowered.api.plugin.annotation.DataDirectory;
import com.velocitypowered.api.proxy.ProxyServer;
import dev.dejvokep.boostedyaml.YamlDocument;
import dev.dejvokep.boostedyaml.dvs.versioning.BasicVersioning;
import dev.dejvokep.boostedyaml.settings.dumper.DumperSettings;
import dev.dejvokep.boostedyaml.settings.general.GeneralSettings;
import dev.dejvokep.boostedyaml.settings.loader.LoaderSettings;
import dev.dejvokep.boostedyaml.settings.updater.UpdaterSettings;
import lombok.Getter;
import dev.anchorlight.zander.velocity.bridge.HubBridgeListener;
import dev.anchorlight.zander.velocity.commands.*;
import dev.anchorlight.zander.velocity.commands.moderation.alert;
import dev.anchorlight.zander.velocity.commands.moderation.clearchat;
import dev.anchorlight.zander.velocity.commands.moderation.freezechat;
import dev.anchorlight.zander.velocity.events.*;
import dev.anchorlight.zander.velocity.events.moderation.FreezeChatListener;
import dev.anchorlight.zander.velocity.events.session.UserOnDisconnect;
import dev.anchorlight.zander.velocity.events.session.UserOnLogin;
import dev.anchorlight.zander.velocity.events.session.UserOnSwitch;
import dev.anchorlight.zander.velocity.util.announcement.TipChatter;
import dev.anchorlight.zander.velocity.util.api.Heartbeat;
import dev.anchorlight.zander.velocity.util.messaging.PrivateMessageService;
import org.slf4j.Logger;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Objects;
import java.util.Optional;

@Plugin(
        id = "zander-velocity",
        authors = "ModularSoft",
        description = "The proxy that allows the connection and integration of the Zander minecraft suite.",
        name = "zander-velocity",
        version = "1.2.0",
        dependencies = {
                @Dependency(id = "signedvelocity"),
                @Dependency(id = "luckperms", optional = false)
        }
)
public class ZanderVelocityMain {
    @Getter
    private static Logger logger;
    @Getter
    public static ProxyServer proxy;
    @Getter
    private static YamlDocument config;
    @Getter
    private static Path dataDirectory;
    @Getter
    private static PrivateMessageService privateMessageService;
    @Getter
    private final CommandManager commandManager;
    @Getter
    private static ZanderVelocityMain instance;

    @Subscribe
    public void onProxyInitialization(ProxyInitializeEvent event) {
        // Event Listeners
        proxy.getEventManager().register(this, new UserChatEvent());
        proxy.getEventManager().register(this, new UserCommandSpyEvent());
        proxy.getEventManager().register(this, new UserOnDisconnect());
        proxy.getEventManager().register(this, new UserOnLogin());
        proxy.getEventManager().register(this, new UserOnProxyPing(this));
        proxy.getEventManager().register(this, new UserOnSwitch());
        proxy.getEventManager().register(this, new UserSocialSpyEvent());
        proxy.getEventManager().register(this, new FreezeChatListener());

        proxy.getChannelRegistrar().register(HubBridgeListener.CHANNEL);
        proxy.getEventManager().register(this, new HubBridgeListener(proxy, logger, config));

        // Commands
        CommandManager commandManager = proxy.getCommandManager();

        commandManager.register(commandManager.metaBuilder("verify").build(), new verify());
        commandManager.register(commandManager.metaBuilder("discord").build(), new discord());
        commandManager.register(commandManager.metaBuilder("rules").build(), new rules());
        commandManager.register(commandManager.metaBuilder("website").build(), new website());
        commandManager.register(commandManager.metaBuilder("link").build(), new link());
        commandManager.register(commandManager.metaBuilder("ping").build(), new ping());
        commandManager.register(commandManager.metaBuilder("report").build(), new report());
        commandManager.register(commandManager.metaBuilder("clearchat").build(), new clearchat());
        commandManager.register(commandManager.metaBuilder("freezechat").build(), new freezechat());
        alert alertCommand = new alert();
        commandManager.register(commandManager.metaBuilder("alert").build(), alertCommand);
        commandManager.register(commandManager.metaBuilder("broadcast").build(), alertCommand);
        message messageCommand = new message();
        commandManager.register(commandManager.metaBuilder("message").build(), messageCommand);
        commandManager.register(commandManager.metaBuilder("m").build(), messageCommand);
        commandManager.register(commandManager.metaBuilder("msg").build(), messageCommand);
        commandManager.register(commandManager.metaBuilder("w").build(), messageCommand);
        commandManager.register(commandManager.metaBuilder("whisper").build(), messageCommand);
        commandManager.register(commandManager.metaBuilder("tell").build(), messageCommand);
        commandManager.register(commandManager.metaBuilder("t").build(), messageCommand);

        reply replyCommand = new reply();
        commandManager.register(commandManager.metaBuilder("reply").build(), replyCommand);
        commandManager.register(commandManager.metaBuilder("r").build(), replyCommand);

        ignore ignoreCommand = new ignore();
        commandManager.register(commandManager.metaBuilder("ignore").build(), ignoreCommand);
        commandManager.register(commandManager.metaBuilder("ignores").build(), ignoreCommand);

        togglemessages toggleMessagesCommand = new togglemessages();
        commandManager.register(commandManager.metaBuilder("togglemessages").build(), toggleMessagesCommand);
        commandManager.register(commandManager.metaBuilder("toggle-messages").build(), toggleMessagesCommand);

        // Start the Heartbeat task
        Heartbeat.startHeartbeatTask();

        // Start the Announcement Tip task
        TipChatter.startAnnouncementTipTask();
    }

    @Inject
    public ZanderVelocityMain(
            ProxyServer proxy,
            Logger logger,
            CommandManager commandManager,
            @DataDirectory Path dataDirectory
    ) {
        this.proxy = proxy;
        this.logger = logger;
        this.commandManager = commandManager;
        this.dataDirectory = dataDirectory;
        instance = this;

        // Create configuration file
        try {
            config = YamlDocument.create(new File(dataDirectory.toFile(), "config.yml"),
                    Objects.requireNonNull(getClass().getResourceAsStream("/config.yml")),
                    GeneralSettings.DEFAULT,
                    LoaderSettings.builder().setAutoUpdate(true).build(),
                    DumperSettings.DEFAULT,
                    UpdaterSettings.builder().setVersioning(new BasicVersioning("config-version"))
                            .setOptionSorting(UpdaterSettings.OptionSorting.SORT_BY_DEFAULTS).build());

            config.update();
            config.save();
        } catch (IOException e) {
            logger.error("Could not create or load plugin configuration, plugin will now be disabled.");
            Optional<PluginContainer> container = proxy.getPluginManager().getPlugin("zander-velocity");
            container.ifPresent(pluginContainer -> pluginContainer.getExecutorService().shutdown());
        }

        logger.info("Zander Proxy has started.");
        privateMessageService = new PrivateMessageService(dataDirectory, logger);
    }
}
