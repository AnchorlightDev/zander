import db from "./databaseController.js";
import webPush from "web-push";

const VAPID_READY = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (VAPID_READY) {
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

let pushSubscriptionTableCheck;

async function ensurePushSubscriptionTable() {
  if (!pushSubscriptionTableCheck) {
    pushSubscriptionTableCheck = new Promise((resolve) => {
      db.query(
        "CREATE TABLE IF NOT EXISTS pushSubscriptions (" +
          "  subscriptionId INT AUTO_INCREMENT PRIMARY KEY," +
          "  userId INT NOT NULL," +
          "  endpoint VARCHAR(2048) NOT NULL," +
          "  p256dh VARCHAR(512) NOT NULL," +
          "  auth VARCHAR(128) NOT NULL," +
          "  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
          "  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
          "  UNIQUE INDEX idx_push_endpoint (endpoint(255))," +
          "  INDEX idx_push_user (userId)" +
          ")",
        (err) => {
          if (err) {
            console.error("Failed to ensure pushSubscriptions table", err);
            resolve(false);
            return;
          }
          resolve(true);
        }
      );
    });
  }
  return pushSubscriptionTableCheck;
}

export async function savePushSubscription(userId, subscription) {
  const hasTable = await ensurePushSubscriptionTable();
  if (!hasTable) return false;

  return new Promise((resolve, reject) => {
    db.query(
      "INSERT INTO pushSubscriptions (userId, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)" +
        " ON DUPLICATE KEY UPDATE userId = VALUES(userId), p256dh = VALUES(p256dh), auth = VALUES(auth), updatedAt = NOW()",
      [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
      (err) => {
        if (err) {
          console.error("Failed to save push subscription", err);
          reject(err);
          return;
        }
        resolve(true);
      }
    );
  });
}

async function getPushSubscriptionsForUsers(userIds) {
  if (!userIds.length) return [];
  const hasTable = await ensurePushSubscriptionTable();
  if (!hasTable) return [];

  const placeholders = userIds.map(() => "?").join(",");
  return new Promise((resolve) => {
    db.query(
      `SELECT endpoint, p256dh, auth FROM pushSubscriptions WHERE userId IN (${placeholders})`,
      userIds,
      (err, results) => {
        if (err) {
          console.error("Failed to get push subscriptions", err);
          resolve([]);
          return;
        }
        resolve(results || []);
      }
    );
  });
}

async function deletePushSubscription(endpoint) {
  return new Promise((resolve) => {
    db.query(
      "DELETE FROM pushSubscriptions WHERE endpoint = ?",
      [endpoint],
      (err) => {
        if (err) {
          console.error("Failed to delete push subscription", err);
        }
        resolve();
      }
    );
  });
}

async function sendWebPushToUsers(userIds, payload) {
  if (!VAPID_READY) return;
  const subscriptions = await getPushSubscriptionsForUsers(userIds);
  if (!subscriptions.length) return;

  const message = JSON.stringify(payload);
  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message
        );
      } catch (error) {
        if (error.statusCode === 410 || error.statusCode === 404) {
          await deletePushSubscription(sub.endpoint);
        } else {
          console.error("Failed to send web push notification", error.message);
        }
      }
    })
  );
}

let notificationTableCheck;

async function ensureNotificationTable() {
  if (!notificationTableCheck) {
    notificationTableCheck = new Promise((resolve) => {
      db.query(
        "CREATE TABLE IF NOT EXISTS userNotifications (\n" +
          "  notificationId INT AUTO_INCREMENT PRIMARY KEY,\n" +
          "  userId INT NOT NULL,\n" +
          "  ticketId INT NULL,\n" +
          "  notificationType VARCHAR(32) NOT NULL,\n" +
          "  title VARCHAR(255) NOT NULL,\n" +
          "  message TEXT NOT NULL,\n" +
          "  url VARCHAR(255) NOT NULL,\n" +
          "  isRead TINYINT(1) NOT NULL DEFAULT 0,\n" +
          "  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
          "  INDEX idx_user_notifications_user (userId),\n" +
          "  INDEX idx_user_notifications_unread (userId, isRead),\n" +
          "  INDEX idx_user_notifications_ticket (ticketId)\n" +
          ") DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        (err) => {
          if (err) {
            console.error("Failed to ensure userNotifications table", err);
            resolve(false);
            return;
          }

          resolve(true);
        },
      );
    });
  }

  return notificationTableCheck;
}

export async function createNotificationsForUsers(userIds, payload) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return 0;

  const uniqueUserIds = [
    ...new Set(
      userIds
        .map((userId) => Number(userId))
        .filter((userId) => Number.isInteger(userId) && userId > 0),
    ),
  ];
  if (!uniqueUserIds.length) return 0;

  const values = uniqueUserIds.map((userId) => [
    userId,
    payload.ticketId ?? null,
    payload.notificationType,
    payload.title,
    payload.message,
    payload.url,
  ]);

  // Insert each notification individually for mysql2 compatibility
  let affectedRows = 0;
  for (const row of values) {
    await new Promise((resolve, reject) => {
      db.query(
        "INSERT INTO userNotifications (userId, ticketId, notificationType, title, message, url) VALUES (?, ?, ?, ?, ?, ?)",
        row,
        (err, results) => {
          if (err) {
            console.error("Failed to insert user notification", err);
            reject(err);
            return;
          }
          affectedRows += results.affectedRows || 0;
          resolve();
        },
      );
    });
  }

  // Fire-and-forget background push to subscribed devices
  sendWebPushToUsers(uniqueUserIds, {
    title: payload.title,
    body: payload.message,
    url: payload.url,
  }).catch((err) => {
    console.error("Failed to send web push notifications", err);
  });

  return affectedRows;
}

export async function getNotificationSummary(userId, limit = 5) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return { unreadCount: 0, items: [] };

  const unreadCountPromise = new Promise((resolve) => {
    db.query(
      "SELECT COUNT(*) as unreadCount FROM userNotifications WHERE userId = ? AND isRead = 0",
      [userId],
      (err, results) => {
        if (err) {
          console.error("Failed to load unread notification count", err);
          resolve(0);
          return;
        }

        resolve(results?.[0]?.unreadCount || 0);
      },
    );
  });

  const notificationsPromise = new Promise((resolve) => {
    db.query(
      "SELECT notificationId, title, message, url, isRead, createdAt FROM userNotifications WHERE userId = ? ORDER BY createdAt DESC LIMIT ?",
      [userId, limit],
      (err, results) => {
        if (err) {
          console.error("Failed to load notifications", err);
          resolve([]);
          return;
        }

        resolve(results || []);
      },
    );
  });

  const [unreadCount, items] = await Promise.all([unreadCountPromise, notificationsPromise]);

  return { unreadCount, items };
}

export async function getUserNotifications(userId, limit = 50) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return [];

  return new Promise((resolve) => {
    db.query(
      "SELECT notificationId, title, message, url, isRead, createdAt FROM userNotifications WHERE userId = ? ORDER BY createdAt DESC LIMIT ?",
      [userId, limit],
      (err, results) => {
        if (err) {
          console.error("Failed to load notifications for user", err);
          resolve([]);
          return;
        }

        resolve(results || []);
      },
    );
  });
}

export async function getNotificationById(notificationId, userId) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return null;

  return new Promise((resolve) => {
    db.query(
      "SELECT notificationId, title, message, url, isRead, createdAt FROM userNotifications WHERE notificationId = ? AND userId = ? LIMIT 1",
      [notificationId, userId],
      (err, results) => {
        if (err) {
          console.error("Failed to load notification", err);
          resolve(null);
          return;
        }

        resolve(results?.[0] || null);
      },
    );
  });
}

export async function markNotificationRead(notificationId, userId) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return false;

  return new Promise((resolve) => {
    db.query(
      "UPDATE userNotifications SET isRead = 1 WHERE notificationId = ? AND userId = ?",
      [notificationId, userId],
      (err, results) => {
        if (err) {
          console.error("Failed to mark notification as read", err);
          resolve(false);
          return;
        }

        resolve(results.affectedRows > 0);
      },
    );
  });
}

export async function markAllNotificationsRead(userId) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return false;

  return new Promise((resolve) => {
    db.query(
      "UPDATE userNotifications SET isRead = 1 WHERE userId = ? AND isRead = 0",
      [userId],
      (err, results) => {
        if (err) {
          console.error("Failed to mark all notifications as read", err);
          resolve(false);
          return;
        }

        resolve(results.affectedRows >= 0);
      },
    );
  });
}

export async function deleteNotification(notificationId, userId) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return false;

  return new Promise((resolve) => {
    db.query(
      "DELETE FROM userNotifications WHERE notificationId = ? AND userId = ?",
      [notificationId, userId],
      (err, results) => {
        if (err) {
          console.error("Failed to delete notification", err);
          resolve(false);
          return;
        }

        resolve(results.affectedRows > 0);
      },
    );
  });
}

export async function deleteAllNotifications(userId) {
  const hasTable = await ensureNotificationTable();
  if (!hasTable) return false;

  return new Promise((resolve) => {
    db.query(
      "DELETE FROM userNotifications WHERE userId = ?",
      [userId],
      (err) => {
        if (err) {
          console.error("Failed to delete all notifications", err);
          resolve(false);
          return;
        }
        resolve(true);
      },
    );
  });
}
