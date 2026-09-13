package dev.anchorlight.zander.velocity.util;

public class ChatFreezeManager {
    private static boolean chatFrozen = false;

    public static boolean isChatFrozen() {
        return chatFrozen;
    }

    public static void setChatFrozen(boolean frozen) {
        chatFrozen = frozen;
    }
}
