package dev.anchorlight.zander.auth.model.user;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

import java.util.UUID;

@Builder
public class UserAuth {

    @Getter UUID uuid;
    @Getter String username;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
