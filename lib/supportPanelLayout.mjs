/**
 * Lays the Discord support panel's category buttons out within Discord's
 * component limits: at most 5 buttons per action row, 5 rows per message,
 * and 80 characters per button label. Pure (no discord.js import) so it can
 * be unit-tested; routes/dashboard/support.js turns the result into builders.
 */
export const BUTTONS_PER_ROW = 5;
export const MAX_ROWS = 5;
export const MAX_LABEL_LENGTH = 80;

export function supportPanelRows(categories = []) {
  const buttons = (categories || [])
    .slice(0, BUTTONS_PER_ROW * MAX_ROWS)
    .map((category) => {
      const name = String(category?.name ?? "").trim() || `Category ${category?.categoryId}`;
      return {
        customId: `support_category_${category.categoryId}`,
        label: name.length > MAX_LABEL_LENGTH ? `${name.slice(0, MAX_LABEL_LENGTH - 1)}…` : name,
      };
    });

  const rows = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
  }
  return rows;
}
