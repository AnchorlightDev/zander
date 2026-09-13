import { getProfilePicture } from "../controllers/userController.js";
import db, { quickshopDb } from "../controllers/databaseController.js";
import pLimit from "p-limit";

// Convert a raw minecraft item ID to a human-readable display name
function formatItemName(rawName) {
  if (!rawName) return "Unknown Item";
  return rawName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Clean and format the DB display_name
function cleanDisplayName(raw) {
  if (!raw) return null;
  return raw
    .replace(/['"]/g, "")
    .trim()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Parse a JSON-like enchantment string from the DB
function parseEnchantmentJson(raw) {
  if (!raw) return null;
  try {
    const cleaned = raw.replace(/['"]/g, '"').trim();
    const obj = JSON.parse(cleaned);
    return Object.entries(obj)
      .map(([key, level]) => {
        const name = key.replace("minecraft:", "").replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return `${name} ${level}`;
      })
      .join(", ");
  } catch {
    return cleanDisplayName(raw);
  }
}

const ITEM_DISPLAY_LABEL = {
  enchanted_book: "Enchanted Book",
  potion: "Potion",
  splash_potion: "Splash Potion",
  lingering_potion: "Lingering Potion",
  tipped_arrow: "Tipped Arrow",
};

const SHULKER_BOX_ITEMS = new Set([
  "shulker_box", "white_shulker_box", "orange_shulker_box", "magenta_shulker_box",
  "light_blue_shulker_box", "yellow_shulker_box", "lime_shulker_box", "pink_shulker_box",
  "gray_shulker_box", "light_gray_shulker_box", "cyan_shulker_box", "purple_shulker_box",
  "blue_shulker_box", "brown_shulker_box", "green_shulker_box", "red_shulker_box",
  "black_shulker_box",
]);

// Parse firework flight duration from item data
// Format: minecraft:fireworks: '{flight_duration:3b}'
function parseFireworkDuration(rawItemYaml) {
  if (!rawItemYaml) return null;
  const match = rawItemYaml.match(/flight_duration:(\d+)b?/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

const MAX_RESULTS = 50;

// Parse shulker box contents from raw QuickShop item data
// Format: minecraft:container: '[{item:{count:64,id:"minecraft:sand"},slot:0},...]'
function parseShulkerContents(rawItemYaml) {
  if (!rawItemYaml) return null;

  // Match the container data - it's a single-line JSON-like array after minecraft:container:
  const containerMatch = rawItemYaml.match(/minecraft:container:\s*'(\[[\s\S]*?\])'/);
  if (!containerMatch) return null;

  const containerJson = containerMatch[1];
  const items = {};

  // Parse item entries: {item:{count:64,id:"minecraft:sand"},slot:0}
  // Extract id and count from each item
  const itemMatches = containerJson.matchAll(/\{item:\{count:(\d+),id:"(?:minecraft:)?([a-z_]+)"\},slot:\d+\}/gi);

  for (const match of itemMatches) {
    const count = parseInt(match[1]) || 1;
    const itemId = match[2].toLowerCase();
    items[itemId] = (items[itemId] || 0) + count;
  }

  if (Object.keys(items).length === 0) return null;

  const formatted = Object.entries(items)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, totalCount]) => {
      const name = formatItemName(id);
      return totalCount > 1 ? `${name} x${totalCount}` : name;
    })
    .join(", ");

  const totalTypes = Object.keys(items).length;
  if (totalTypes > 3) {
    return `${formatted} +${totalTypes - 3} more`;
  }
  return formatted;
}

/**
 * Search shops by material
 * @param {string} material - Search term (min 2 chars)
 * @param {number} page - Page number (1-indexed)
 * @param {Object} options - Optional settings
 * @param {boolean} options.includeProfilePictures - Whether to fetch profile pictures (slower)
 * @returns {Promise<{success: boolean, data?: Array, pagination?: Object, message?: string}>}
 */
export async function searchShops(material, page = 1, options = {}) {
  const { includeProfilePictures = true } = options;
  const concurrencyLimit = pLimit(20);

  if (!material || material.trim().length < 2) {
    return {
      success: false,
      message: "Please enter a search term (at least 2 characters).",
    };
  }

  // Per-request caches
  const itemCache = new Map();
  const userCache = new Map();
  const profilePicCache = new Map();
  const shulkerCache = new Map();

  async function fetchItemData(itemName) {
    if (itemCache.has(itemName)) return itemCache.get(itemName);
    const promise = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const itemResponse = await fetch(
          `https://craftdex.onrender.com/search/${itemName}`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (itemResponse.ok) {
          const data = await itemResponse.json();
          return data.data || {};
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Error fetching item data:", err);
        }
      }
      return {};
    })();
    itemCache.set(itemName, promise);
    return promise;
  }

  async function fetchUserData(uuid) {
    if (userCache.has(uuid)) return userCache.get(uuid);
    const promise = new Promise((resolve) => {
      db.query(
        `SELECT userId, username, discordId FROM users WHERE uuid = ?`,
        [uuid],
        (error, results) => {
          if (error) {
            console.error("Error fetching user data:", error);
            return resolve({});
          }
          resolve(results?.[0] || {});
        }
      );
    });
    userCache.set(uuid, promise);
    return promise;
  }

  async function fetchProfilePicture(username) {
    if (!username || !includeProfilePictures) return "";
    if (profilePicCache.has(username)) return profilePicCache.get(username);
    const promise = (async () => {
      try {
        return await getProfilePicture(username) || "";
      } catch (err) {
        console.error("Error fetching profile picture:", err);
        return "";
      }
    })();
    profilePicCache.set(username, promise);
    return promise;
  }

  async function fetchShulkerContents(shopId) {
    if (shulkerCache.has(shopId)) return shulkerCache.get(shopId);
    const promise = new Promise((resolve) => {
      quickshopDb.query(
        `SELECT d.item FROM qs_shops s
         JOIN qs_data d ON s.data = d.id
         WHERE s.id = ?`,
        [shopId],
        (error, results) => {
          if (error || !results?.[0]?.item) {
            return resolve(null);
          }
          resolve(parseShulkerContents(results[0].item));
        }
      );
    });
    shulkerCache.set(shopId, promise);
    return promise;
  }

  // Cache for raw item data (reused for firework duration)
  const rawItemCache = new Map();

  async function fetchRawItemData(shopId) {
    if (rawItemCache.has(shopId)) return rawItemCache.get(shopId);
    const promise = new Promise((resolve) => {
      quickshopDb.query(
        `SELECT d.item FROM qs_shops s
         JOIN qs_data d ON s.data = d.id
         WHERE s.id = ?`,
        [shopId],
        (error, results) => {
          if (error || !results?.[0]?.item) {
            return resolve(null);
          }
          resolve(results[0].item);
        }
      );
    });
    rawItemCache.set(shopId, promise);
    return promise;
  }

  try {
    const safePage = Math.max(1, parseInt(page) || 1);
    const underscored = material.toUpperCase().replace(/ /g, "_");
    const likeTerm = `%${material}%`;
    const likeTermUnderscored = `%${underscored}%`;

    // Get total count for pagination.
    // qs_data.item stores plain YAML for old shops and base64+gzip NBT for new ones
    // (QuickShop-Hikari changed format ~2026-04-22, id ≥ 6000). The indexing cron
    // decodes new-format rows and writes the bare item ID into data.name so we can
    // still search them with a LIKE query.
    const totalCount = await new Promise((resolve, reject) => {
      quickshopDb.query(
        `SELECT COUNT(*) AS total
         FROM qs_shops shops
         JOIN qs_shop_map map ON shops.id = map.shop
         JOIN qs_data data ON shops.data = data.id
         JOIN qs_external_cache stock ON shops.id = stock.shop
         WHERE data.unlimited = 0
           AND (
             (data.item LIKE 'item:%' AND (data.item LIKE ? OR data.item LIKE ?))
             OR
             (data.item NOT LIKE 'item:%' AND (
               JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) LIKE ?
               OR JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) LIKE ?
             ))
           )`,
        [likeTerm, likeTermUnderscored, likeTerm, likeTermUnderscored],
        (error, results) => {
          if (error) return reject(error);
          resolve(results[0]?.total || 0);
        }
      );
    });

    if (totalCount === 0) {
      return {
        success: false,
        message: "No shops found matching your search.",
      };
    }

    const totalPages = Math.ceil(totalCount / MAX_RESULTS);
    const currentPage = Math.min(safePage, totalPages);
    const offset = (currentPage - 1) * MAX_RESULTS;

    // Fetch the page of results — replicate the shoppingDirectory VIEW logic
    // directly against the QuickShop pool (cross-server JOINs are not possible).
    // For new-format shops (item NOT LIKE 'item:%'), the item ID comes from data.name
    // (populated by shopItemIndexCron) and component extraction falls back to NULL.
    const results = await new Promise((resolve, reject) => {
      quickshopDb.query(
        `SELECT
           shops.id,
           data.owner AS uuid,
           CASE
             WHEN data.item LIKE 'item:%' THEN
               REPLACE(TRIM(SUBSTRING_INDEX(
                 SUBSTR(data.item, LOCATE('id:', data.item) + 3), '\n', 1
               )), 'minecraft:', '')
             ELSE JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id'))
           END AS item,
           CASE
             WHEN data.item NOT LIKE 'item:%' THEN
               JSON_EXTRACT(data.name, '$.count')
             WHEN LOCATE('count:', data.item) = 0 THEN NULL
             ELSE TRIM(SUBSTRING_INDEX(
               SUBSTR(data.item, LOCATE('count:', data.item) + 6), '\n', 1
             ))
           END AS amount,
           data.price,
           stock.stock,
           map.world,
           map.x,
           map.y,
           map.z,
           CASE
             WHEN data.item NOT LIKE 'item:%' THEN NULL
             WHEN LOCATE('minecraft:stored_enchantments:', data.item) > 0
             THEN CONCAT(
               CONCAT(
                 UPPER(LEFT(REPLACE(REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(
                   REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(
                     SUBSTR(data.item, LOCATE('minecraft:stored_enchantments:', data.item) + 30),
                     '\n', 1)), '{"minecraft:', ''), '}', ''), ''':"', 1)),
                   '''', ''), '"', ''), '_', ' '), 1)),
                 LOWER(SUBSTRING(REPLACE(REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(
                   REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(
                     SUBSTR(data.item, LOCATE('minecraft:stored_enchantments:', data.item) + 30),
                     '\n', 1)), '{"minecraft:', ''), '}', ''), ''':"', 1)),
                   '''', ''), '"', ''), '_', ' '), 2))
               ),
               ' ',
               REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(
                 SUBSTR(data.item, LOCATE('minecraft:stored_enchantments:', data.item) + 30),
                 '\n', 1)), '{"minecraft:', ''), '}', ''), ''':"', -1)), '"', ''), '''', '')
             )
             WHEN LOCATE('minecraft:potion_contents:', data.item) > 0
             THEN REPLACE(REPLACE(REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(
               SUBSTR(data.item, LOCATE('minecraft:potion_contents:', data.item) + 26),
               '\n', 1)), '{potion:"minecraft:', ''), '"}', ''), '''', ''), '}', '')
             WHEN LOCATE('minecraft:enchantments:', data.item) > 0
             THEN REPLACE(REPLACE(TRIM(SUBSTRING_INDEX(
               SUBSTR(data.item, LOCATE('minecraft:enchantments:', data.item) + 23),
               '\n', 1)), '''', ''), ' ', '')
             ELSE NULL
           END AS display_name
         FROM qs_shops shops
         JOIN qs_shop_map map ON shops.id = map.shop
         JOIN qs_data data ON shops.data = data.id
         JOIN qs_external_cache stock ON shops.id = stock.shop
         WHERE data.unlimited = 0
           AND (
             (data.item LIKE 'item:%' AND (data.item LIKE ? OR data.item LIKE ?))
             OR
             (data.item NOT LIKE 'item:%' AND (
               JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) LIKE ?
               OR JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) LIKE ?
             ))
           )
         ORDER BY shops.id
         LIMIT ? OFFSET ?`,
        [likeTerm, likeTermUnderscored, likeTerm, likeTermUnderscored, MAX_RESULTS, offset],
        (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        }
      );
    });

    // Enrich results
    const modifiedShops = await Promise.all(
      results.map((shop) =>
        concurrencyLimit(async () => {
          const itemName = shop.item.trim();

          const [itemData, userData] = await Promise.all([
            fetchItemData(itemName),
            fetchUserData(shop.uuid),
          ]);

          const profilePicture = await fetchProfilePicture(userData.username);

          let displayName = itemData.displayName || formatItemName(itemName);
          const parentLabel = ITEM_DISPLAY_LABEL[itemName];
          let shulkerContents = null;

          if (shop.display_name && parentLabel) {
            const cleanedDetail = cleanDisplayName(shop.display_name);
            if (cleanedDetail) {
              displayName = `${parentLabel} (${cleanedDetail})`;
            }
          } else if (shop.display_name && shop.display_name.includes("{")) {
            const enchantList = parseEnchantmentJson(shop.display_name);
            if (enchantList) {
              displayName = `${displayName} (${enchantList})`;
            }
          } else if (SHULKER_BOX_ITEMS.has(itemName)) {
            shulkerContents = await fetchShulkerContents(shop.id);
          } else if (itemName === "firework_rocket") {
            // Fetch raw item data to get flight duration
            const rawItem = await fetchRawItemData(shop.id);
            const duration = parseFireworkDuration(rawItem);
            if (duration !== null) {
              displayName = `${displayName} (Duration ${duration})`;
            }
          }

          return {
            ...shop,
            itemData: {
              ...itemData,
              displayName,
            },
            userData: {
              username: userData.username || "",
              discordId: userData.discordId || "",
              profilePicture,
            },
            shulkerContents,
          };
        })
      )
    );

    return {
      success: true,
      data: modifiedShops,
      pagination: {
        page: currentPage,
        totalPages,
        totalResults: totalCount,
        perPage: MAX_RESULTS,
      },
    };
  } catch (error) {
    console.error("Shop search error:", error);
    return {
      success: false,
      message: `Error searching shops: ${error.message}`,
    };
  }
}
