import { hashEmail } from "../api/common.js";
import { prisma } from "../controllers/databaseController.js";

export async function resolveAvatarUrl(user) {
  if (!user) return null;
  if (user.profilePicture_type === "CRAFTATAR" && user.uuid) {
    return `https://crafthead.net/avatar/${user.uuid}`;
  }
  if (user.profilePicture_type === "GRAVATAR" && user.profilePicture_email) {
    const hash = await hashEmail(user.profilePicture_email);
    return `https://gravatar.com/avatar/${hash}?size=128`;
  }
  if (user.uuid) return `https://crafthead.net/avatar/${user.uuid}`;
  return `https://mc-heads.net/avatar/${user.username}/128`;
}

export async function enrichHostsWithAvatars(hosts) {
  const userIds = hosts.map(h => h.userId).filter(Boolean);
  const users = userIds.length
    ? await prisma.users.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, uuid: true, username: true, profilePicture_type: true, profilePicture_email: true },
      })
    : [];
  const userMap = Object.fromEntries(users.map(u => [u.userId, u]));

  return Promise.all(hosts.map(async h => ({
    ...h,
    avatarUrl: h.userId ? await resolveAvatarUrl(userMap[h.userId] || null) : null,
  })));
}
