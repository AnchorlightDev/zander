import { getWebAnnouncement } from "../controllers/announcementController.js";
import { getGlobalImage, setBannerCookie } from "../api/common.js";
import {
  getNotificationSummary,
  getUserNotifications,
  getNotificationById,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  deleteAllNotifications,
  savePushSubscription,
} from "../controllers/notificationController.js";

export default function notificationRoutes(app, config, features) {
  app.get("/notifications", async function (req, res) {
    if (!req.session.user) {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notLoggedIn", {
        pageTitle: "Not Logged In",
        config,
        req,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }

    const notifications = await getUserNotifications(req.session.user.userId, 50);
    const summary = await getNotificationSummary(req.session.user.userId, 50);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/notifications/index", {
      pageTitle: "Notifications",
      pageDescription: "Notifications",
      config,
      req,
      features,
      notifications,
      unreadCount: summary.unreadCount,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.get("/notifications/vapid-public-key", async function (req, res) {
    return res.send({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
  });

  app.post("/notifications/push-subscribe", async function (req, res) {
    if (!req.session.user) {
      return res.status(401).send({ error: "Not authenticated" });
    }

    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).send({ error: "Invalid subscription" });
    }

    try {
      await savePushSubscription(req.session.user.userId, subscription);
      return res.status(201).send({ success: true });
    } catch (error) {
      console.error("[NOTIFICATION] Failed to save push subscription", error);
      return res.status(500).send({ error: "Failed to save subscription" });
    }
  });

  app.get("/notifications/summary", async function (req, res) {
    if (!req.session.user) {
      return res.status(401).send({ error: "Not authenticated" });
    }

    const summary = await getNotificationSummary(req.session.user.userId, 10);

    return res.send({
      unreadCount: summary.unreadCount,
      items: summary.items.map((item) => ({
        notificationId: item.notificationId,
        title: item.title,
        message: item.message,
        url: item.url,
        isRead: item.isRead,
        createdAt: item.createdAt,
      })),
    });
  });

  app.get("/notifications/visit/:id", async function (req, res) {
    if (!req.session.user) {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notLoggedIn", {
        pageTitle: "Not Logged In",
        config,
        req,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }

    const notificationId = Number(req.params.id);
    if (!notificationId) {
      setBannerCookie("warning", "Notification not found.", res);
      return res.redirect("/notifications");
    }

    const notification = await getNotificationById(
      notificationId,
      req.session.user.userId
    );

    if (!notification) {
      setBannerCookie("warning", "Notification not found.", res);
      return res.redirect("/notifications");
    }

    await markNotificationRead(notificationId, req.session.user.userId);

    return res.redirect(notification.url || "/notifications");
  });

  app.post("/notifications/mark-all", async function (req, res) {
    if (!req.session.user) {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notLoggedIn", {
        pageTitle: "Not Logged In",
        config,
        req,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }

    await markAllNotificationsRead(req.session.user.userId);
    setBannerCookie("success", "All notifications marked as read.", res);
    return res.redirect("/notifications");
  });

  app.post("/notifications/clear-all", async function (req, res) {
    if (!req.session.user) {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notLoggedIn", {
        pageTitle: "Not Logged In",
        config,
        req,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }

    await deleteAllNotifications(req.session.user.userId);
    setBannerCookie("success", "All notifications cleared.", res);
    return res.redirect("/notifications");
  });

  app.post("/notifications/:id/dismiss", async function (req, res) {
    if (!req.session.user) {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notLoggedIn", {
        pageTitle: "Not Logged In",
        config,
        req,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }

    const notificationId = Number(req.params.id);
    if (!notificationId) {
      setBannerCookie("warning", "Notification not found.", res);
      return res.redirect("/notifications");
    }

    const deleted = await deleteNotification(notificationId, req.session.user.userId);
    if (!deleted) {
      setBannerCookie("warning", "Notification not found.", res);
      return res.redirect("/notifications");
    }

    setBannerCookie("success", "Notification dismissed.", res);
    return res.redirect("/notifications");
  });
}
