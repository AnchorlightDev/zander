/**
 * controllers/customPageController.js
 *
 * Staff-written pages served at /<slug>. Validation is in
 * lib/customPages.mjs; content is sanitised here on save.
 */

import { prisma } from "./databaseController.js";
import { sanitizeForumHtml } from "../lib/htmlSanitize.js";

const LIST_FIELDS = {
  pageId: true,
  slug: true,
  title: true,
  status: true,
  updatedAt: true,
};

export function listPages() {
  return prisma.customPages.findMany({ select: LIST_FIELDS, orderBy: { title: "asc" } });
}

export function listPublishedPages() {
  return prisma.customPages.findMany({
    where: { status: "published" },
    select: LIST_FIELDS,
    orderBy: { title: "asc" },
  });
}

export function getPageById(pageId) {
  // "/dashboard/pages/abc/edit" should answer "no such page", not a Prisma
  // validation error.
  const id = Number.parseInt(pageId, 10);
  if (!Number.isInteger(id) || id < 1) return Promise.resolve(null);
  return prisma.customPages.findUnique({ where: { pageId: id } });
}

export function getPageBySlug(slug) {
  return prisma.customPages.findUnique({ where: { slug } });
}

/** True when a page other than `exceptPageId` already uses the slug. */
export async function isSlugUsedByAnotherPage(slug, exceptPageId = null) {
  const existing = await prisma.customPages.findUnique({ where: { slug }, select: { pageId: true } });
  return Boolean(existing && existing.pageId !== Number(exceptPageId));
}

export function createPage(value, userId) {
  return prisma.customPages.create({
    data: {
      ...value,
      content: sanitizeForumHtml(value.content),
      createdByUserId: userId ?? null,
      updatedByUserId: userId ?? null,
    },
  });
}

export function updatePage(pageId, value, userId) {
  return prisma.customPages.update({
    where: { pageId: Number(pageId) },
    data: { ...value, content: sanitizeForumHtml(value.content), updatedByUserId: userId ?? null },
  });
}

export function deletePage(pageId) {
  return prisma.customPages.delete({ where: { pageId: Number(pageId) } });
}
