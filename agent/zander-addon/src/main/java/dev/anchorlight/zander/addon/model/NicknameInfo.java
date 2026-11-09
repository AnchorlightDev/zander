package dev.anchorlight.zander.addon.model;

/** Effective nickname for a player, from GET /api/nickname/effective. */
public class NicknameInfo {
    public final String realname;
    public final String nickname; // null when none / hidden
    public final String color;    // null = default colour
    public final boolean isNick;

    public NicknameInfo(String realname, String nickname, String color, boolean isNick) {
        this.realname = realname;
        this.nickname = nickname;
        this.color = color;
        this.isNick = isNick;
    }

    public static NicknameInfo plain(String realname) {
        return new NicknameInfo(realname, null, null, false);
    }
}
