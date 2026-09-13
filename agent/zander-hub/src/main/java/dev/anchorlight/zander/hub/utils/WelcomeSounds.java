package dev.anchorlight.zander.hub.utils;

import org.bukkit.Sound;

/**
 * Utility class providing functions on welcome sounds.
 */
public final class WelcomeSounds {

    private static final Sound[] SOUNDS = {
            Sound.BLOCK_AMETHYST_BLOCK_FALL,
            Sound.BLOCK_AMETHYST_CLUSTER_BREAK,
            Sound.BLOCK_BEACON_ACTIVATE,
            Sound.BLOCK_BELL_RESONATE,
            Sound.BLOCK_CAMPFIRE_CRACKLE,
            Sound.BLOCK_COMPOSTER_FILL_SUCCESS,
            Sound.BLOCK_COPPER_FALL,
            Sound.BLOCK_DECORATED_POT_HIT,
            Sound.BLOCK_ENCHANTMENT_TABLE_USE,
            Sound.BLOCK_ENDER_CHEST_OPEN,
            Sound.BLOCK_END_PORTAL_FRAME_FILL,
            Sound.BLOCK_NETHERITE_BLOCK_STEP,
            Sound.BLOCK_RESPAWN_ANCHOR_CHARGE,
            Sound.BLOCK_RESPAWN_ANCHOR_DEPLETE,
            Sound.BLOCK_SCAFFOLDING_PLACE,
            Sound.BLOCK_WATER_AMBIENT,
            Sound.ENTITY_ALLAY_AMBIENT_WITHOUT_ITEM,
            Sound.ENTITY_ARMOR_STAND_BREAK,
            Sound.ENTITY_AXOLOTL_SPLASH,
            Sound.ENTITY_CAT_PURREOW,
            Sound.ENTITY_CHICKEN_DEATH,
            Sound.ENTITY_CREEPER_PRIMED,
            Sound.ENTITY_DOLPHIN_ATTACK,
            Sound.ENTITY_ENDERMAN_TELEPORT,
            Sound.ENTITY_ENDER_DRAGON_HURT,
            Sound.ENTITY_EVOKER_DEATH,
            Sound.ENTITY_FROG_DEATH,
            Sound.ENTITY_GLOW_SQUID_AMBIENT,
            Sound.ENTITY_GOAT_AMBIENT,
            Sound.ENTITY_HOGLIN_AMBIENT,
            Sound.ENTITY_PIGLIN_ADMIRING_ITEM,
            Sound.ENTITY_PIG_AMBIENT,
            Sound.ENTITY_PLAYER_BIG_FALL,
            Sound.ENTITY_PLAYER_HURT_FREEZE,
            Sound.ENTITY_SHULKER_SHOOT,
            Sound.ENTITY_VILLAGER_HURT,
            Sound.ENTITY_WANDERING_TRADER_AMBIENT,
            Sound.ENTITY_WANDERING_TRADER_DISAPPEARED,
            Sound.ENTITY_WANDERING_TRADER_REAPPEARED,
            Sound.ENTITY_WARDEN_NEARBY_CLOSER,
            Sound.ENTITY_WITCH_HURT,
            Sound.ENTITY_WITHER_SKELETON_STEP,
            Sound.ENTITY_ZOMBIE_INFECT,
    };

    private WelcomeSounds() {
        throw new IllegalStateException("Utility class shouldn't be instantiated");
    }

    public static Sound getRandomSound() {
        return SOUNDS[(int) (Math.random() * SOUNDS.length)];
    }
}
