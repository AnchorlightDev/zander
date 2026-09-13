package org.modularsoft.zander.waterfall.model.user;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

import java.util.UUID;

@Builder
public class UserCreation {

    @Getter UUID uuid;
    @Getter String username;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}
