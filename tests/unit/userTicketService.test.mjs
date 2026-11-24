import { describe, it, expect, vi, beforeEach } from "vitest";
const { tickets, categories } = vi.hoisted(() => ({ tickets: vi.fn(), categories: vi.fn() }));
vi.mock("../../controllers/supportTicketController.js", () => ({ getTicketsAccessibleByUser: tickets, getSupportCategories: categories }));
import { getStaffUserTickets } from "../../services/userTicketService.js";
beforeEach(() => vi.resetAllMocks());
describe("staff user ticket history", () => {
  it("does not query tickets for guests, players, or staff without ticket access", async () => {
    for (const viewer of [undefined, { isStaff: false, permissions: ["*"] }, { isStaff: true, permissions: [] }]) {
      expect(await getStaffUserTickets(9, viewer)).toEqual([]);
    }
    expect(tickets).not.toHaveBeenCalled();
    expect(categories).not.toHaveBeenCalled();
  });
  it("includes closed tickets, excludes forbidden categories, and uses direct participation only", async () => {
    categories.mockResolvedValue([{ categoryId: 1, name: "Player Support" }, { categoryId: 2, slug: "private" }]);
    tickets.mockResolvedValue([
      { ticketId: 1, categoryId: 1, title: "Old", status: "closed", guestToken: "secret" },
      { ticketId: 3, categoryId: 2, title: "Private" },
      { ticketId: 2, categoryId: 1, title: "New", status: "open" },
    ]);
    const result = await getStaffUserTickets(9, { isStaff: true, permissions: ["zander.web.tickets", "zander.web.tickets.player-support"] });
    expect(tickets).toHaveBeenCalledWith(9, []);
    expect(result.map(t => t.ticketId)).toEqual([2, 1]);
    expect(result[1].status).toBe("closed");
    expect(result[1]).not.toHaveProperty("guestToken");
  });
});
