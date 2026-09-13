package dev.anchorlight.zander.addon.commands;

import net.kyori.adventure.inventory.Book;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.jetbrains.annotations.NotNull;
import dev.anchorlight.zander.addon.ZanderAddonMain;
import dev.anchorlight.zander.addon.service.PolicyService;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class PolicyCommand implements CommandExecutor {
    private final ZanderAddonMain plugin;
    private final PolicyService policyService;

    public PolicyCommand(ZanderAddonMain plugin, PolicyService policyService) {
        this.plugin = plugin;
        this.policyService = policyService;
    }

    @Override
    public boolean onCommand(@NotNull CommandSender sender, @NotNull Command command, @NotNull String label, @NotNull String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("This command can only be used by players.", NamedTextColor.RED));
            return true;
        }

        if (args.length == 0) {
            player.sendMessage(Component.text("Usage: /policy <tos|rules|privacy|refund>", NamedTextColor.RED));
            return true;
        }

        String type = args[0].toLowerCase();
        policyService.fetchPolicyUrls().thenAccept(config -> {
            String url;
            String title;
            switch (type) {
                case "tos":
                    url = config.getTermsOfService();
                    title = "Terms of Service";
                    break;
                case "rules":
                    url = config.getRules();
                    title = "Rules";
                    break;
                case "privacy":
                    url = config.getPrivacy();
                    title = "Privacy Policy";
                    break;
                case "refund":
                    url = config.getRefund();
                    title = "Refund Policy";
                    break;
                default:
                    player.sendMessage(Component.text("Invalid policy type. Use tos, rules, privacy, or refund.", NamedTextColor.RED));
                    return;
            }

            policyService.fetchPolicyContent(url).thenAccept(content -> {
                // Perform UI operation on the main thread
                Bukkit.getScheduler().runTask(plugin, () -> openBook(player, title, content));
            }).exceptionally(ex -> {
                player.sendMessage(Component.text("Failed to fetch policy content.", NamedTextColor.RED));
                return null;
            });
        }).exceptionally(ex -> {
            player.sendMessage(Component.text("Failed to fetch policy configuration.", NamedTextColor.RED));
            return null;
        });

        return true;
    }

    private void openBook(Player player, String title, String content) {
        List<Component> pages = paginate(player, content);
        Book book = Book.book(Component.text(title), Component.text("CraftingForChrist"), pages);
        player.openBook(book);
    }

    private List<Component> paginate(Player player, String content) {
        List<Component> pages = new ArrayList<>();
        int maxLinesPerPage = 14;

        String[] rawLines = content.split("\n");
        List<Component> formattedLines = new ArrayList<>();

        for (String line : rawLines) {
            formattedLines.addAll(parseMarkdownLine(line));
        }

        TextComponent.Builder pageBuilder = Component.text();
        int lineCount = 0;

        for (Component line : formattedLines) {
            pageBuilder.append(line).append(Component.newline());
            lineCount++;

            if (lineCount >= maxLinesPerPage) {
                pages.add(pageBuilder.build());
                pageBuilder = Component.text();
                lineCount = 0;
            }
        }

        if (lineCount > 0) {
            pages.add(pageBuilder.build());
        }

        if (pages.isEmpty()) {
            pages.add(Component.empty());
        }

        return pages;
    }

    private List<Component> parseMarkdownLine(String line) {
        // Pre-process HTML entities and common tags
        line = line.replace("&nbsp;", " ")
                   .replace("&amp;", "&")
                   .replace("&lt;", "<")
                   .replace("&gt;", ">")
                   .replace("&quot;", "\"")
                   .replace("&#39;", "'")
                   .replace("<br>", "\n")
                   .replace("<br/>", "\n");

        if (line.contains("\n")) {
            String[] parts = line.split("\n");
            List<Component> result = new ArrayList<>();
            for (String part : parts) {
                result.addAll(parseMarkdownLine(part));
            }
            return result;
        }

        if (line.trim().isEmpty()) {
            return List.of(Component.empty());
        }

        // Headings
        if (line.startsWith("# ")) {
            return wrapComponent(parseInlineMarkdown(line.substring(2)).color(NamedTextColor.DARK_BLUE).decorate(TextDecoration.BOLD), 18);
        } else if (line.startsWith("## ")) {
            return wrapComponent(parseInlineMarkdown(line.substring(3)).color(NamedTextColor.BLUE).decorate(TextDecoration.BOLD), 18);
        } else if (line.startsWith("### ")) {
            return wrapComponent(parseInlineMarkdown(line.substring(4)).color(NamedTextColor.DARK_AQUA).decorate(TextDecoration.BOLD), 18);
        }

        // Blockquotes
        if (line.startsWith("> ")) {
            return wrapComponent(Component.text("> ", NamedTextColor.GRAY).append(parseInlineMarkdown(line.substring(2)).color(NamedTextColor.GRAY)), 22);
        }

        return wrapComponent(parseInlineMarkdown(line), 22);
    }

    private Component parseInlineMarkdown(String text) {
        TextComponent.Builder builder = Component.text();
        int lastIdx = 0;

        int i = 0;
        while (i < text.length()) {
            // Markdown Links [text](url)
            if (text.startsWith("[", i)) {
                int endBracket = text.indexOf(']', i);
                if (endBracket != -1 && endBracket + 1 < text.length() && text.charAt(endBracket + 1) == '(') {
                    int endParen = text.indexOf(')', endBracket + 2);
                    if (endParen != -1) {
                        builder.append(Component.text(text.substring(lastIdx, i)));
                        String linkText = text.substring(i + 1, endBracket);
                        String url = text.substring(endBracket + 2, endParen);
                        builder.append(Component.text(linkText).color(NamedTextColor.BLUE).decorate(TextDecoration.UNDERLINED).clickEvent(ClickEvent.openUrl(url)));
                        i = endParen + 1;
                        lastIdx = i;
                        continue;
                    }
                }
            }
            // HTML-style Links <a href="url">text</a> or mailto
            else if (text.startsWith("<a ", i)) {
                int hrefStart = text.indexOf("href=\"", i);
                if (hrefStart != -1) {
                    int hrefEnd = text.indexOf("\"", hrefStart + 6);
                    int tagClose = text.indexOf(">", i);
                    int endTag = text.indexOf("</a>", tagClose);
                    if (hrefEnd != -1 && tagClose != -1 && endTag != -1 && hrefEnd < tagClose) {
                        builder.append(Component.text(text.substring(lastIdx, i)));
                        String url = text.substring(hrefStart + 6, hrefEnd);
                        String linkText = text.substring(tagClose + 1, endTag);
                        builder.append(Component.text(linkText).color(NamedTextColor.BLUE).decorate(TextDecoration.UNDERLINED).clickEvent(ClickEvent.openUrl(url)));
                        i = endTag + 4;
                        lastIdx = i;
                        continue;
                    }
                }
            }
            // Simple URL/Email in brackets <url>
            else if (text.startsWith("<", i)) {
                int endBracket = text.indexOf(">", i);
                if (endBracket != -1) {
                    String potentialUrl = text.substring(i + 1, endBracket);
                    if (potentialUrl.contains("://") || potentialUrl.contains("@")) {
                        builder.append(Component.text(text.substring(lastIdx, i)));
                        String url = potentialUrl.contains("@") && !potentialUrl.startsWith("mailto:") ? "mailto:" + potentialUrl : potentialUrl;
                        builder.append(Component.text(potentialUrl).color(NamedTextColor.BLUE).decorate(TextDecoration.UNDERLINED).clickEvent(ClickEvent.openUrl(url)));
                        i = endBracket + 1;
                        lastIdx = i;
                        continue;
                    }
                }
            }
            i++;
        }

        builder.append(Component.text(text.substring(lastIdx)));
        return builder.build();
    }

    private List<Component> wrapComponent(Component component, int maxCharsPerLine) {
        List<Component> wrappedLines = new ArrayList<>();
        TextComponent.Builder currentLine = Component.text();
        int currentLength = 0;

        // Flatten the component and its children
        List<Component> parts = new ArrayList<>();
        flatten(component, parts);

        for (Component part : parts) {
            if (!(part instanceof TextComponent textPart)) {
                // Should not happen as we flatten into text components
                continue;
            }

            String text = textPart.content();
            if (text.isEmpty()) continue;

            String[] words = text.split("(?<=\\s)|(?=\\s)"); // Split but keep whitespace

            for (String word : words) {
                if (currentLength + word.length() > maxCharsPerLine && currentLength > 0) {
                    wrappedLines.add(currentLine.build());
                    currentLine = Component.text();
                    currentLength = 0;
                    // If word is whitespace at start of line, skip it
                    if (word.matches("\\s+")) continue;
                }

                // If it's a link (has click event), we try to wrap it nicely but if it's longer than a line...
                if (textPart.clickEvent() != null && word.length() > maxCharsPerLine) {
                    // Split word and preserve formatting
                    int i = 0;
                    while (i < word.length()) {
                        int end = Math.min(i + maxCharsPerLine, word.length());
                        currentLine.append(Component.text(word.substring(i, end)).style(textPart.style()));
                        wrappedLines.add(currentLine.build());
                        currentLine = Component.text();
                        currentLength = 0;
                        i = end;
                    }
                    continue;
                }

                currentLine.append(Component.text(word).style(textPart.style()));
                currentLength += word.length();
            }
        }

        if (currentLength > 0) {
            wrappedLines.add(currentLine.build());
        }

        return wrappedLines;
    }

    private void flatten(Component component, List<Component> parts) {
        parts.add(component.children(Collections.emptyList()));
        for (Component child : component.children()) {
            flatten(child, parts);
        }
    }
}
