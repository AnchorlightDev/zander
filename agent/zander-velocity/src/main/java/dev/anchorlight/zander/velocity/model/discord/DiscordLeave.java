package dev.anchorlight.zander.velocity.model.discord;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class DiscordLeave {

    @Getter String username;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
