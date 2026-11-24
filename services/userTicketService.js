import { getTicketsAccessibleByUser, getSupportCategories } from "../controllers/supportTicketController.js";
import { hasPermissionSilent } from "../controllers/userAccountState.js";

export function canViewUserTickets(viewer, permissions = viewer?.permissions) {
  return Boolean(viewer?.isStaff && hasPermissionSilent("zander.web.tickets", permissions));
}

// Direct ownership/participation only: a player's rank must not pull unrelated tickets into their history.
export async function getStaffUserTickets(userId, viewer, permissions = viewer?.permissions) {
  if (!canViewUserTickets(viewer, permissions)) return [];
  const categories = await getSupportCategories();
  const allowed = new Map(categories.filter((category) => {
    const slug = category.slug || String(category.name || `category-${category.categoryId}`)
      .toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-")
      .replace(/-+/g, "-").replace(/(^-|-$)/g, "");
    return slug && hasPermissionSilent(`zander.web.tickets.${slug}`, permissions);
  }).map((category) => [String(category.categoryId), category.name]));
  if (!allowed.size) return [];
  const tickets = await getTicketsAccessibleByUser(userId, []);
  return tickets.filter((ticket) => allowed.has(String(ticket.categoryId)))
    .map((ticket) => ({ ticketId: ticket.ticketId, title: ticket.title,
      status: ticket.status, createdAt: ticket.createdAt,
      categoryName: allowed.get(String(ticket.categoryId)) }))
    .sort((a, b) => Number(b.ticketId) - Number(a.ticketId));
}
