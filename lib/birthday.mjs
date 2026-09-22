/**
 * lib/birthday.mjs
 *
 * Birthdays as a day and a month, with no year.
 *
 * Imports only lib/timezones.mjs, which imports nothing.
 *
 * The missing year is the point. Storing a full date means storing an age, and
 * an age is personal data this community has no use for -- it only wants to say
 * happy birthday. Two small integers say exactly that and cannot accidentally
 * be rendered, exported or inferred into an age.
 */

import { localDateParts } from "./timezones.mjs";

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Longest possible length of each month.
 *
 * February is 29 because there is no year to test against -- somebody born on
 * the 29th must be able to record it.
 */
const MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a month for a specific year, which does know about leap years. */
function daysInMonth(month, year) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A stored birthday, or null when the pair is not a real day of the year.
 *
 * Both parts are required: a month with no day is not a birthday.
 */
export function normaliseBirthday(day, month) {
  const d = Number(day);
  const m = Number(month);

  if (!Number.isInteger(d) || !Number.isInteger(m)) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > MAX_DAY[m - 1]) return null;

  return { day: d, month: m };
}

/** "14 March", or "" when there is nothing stored. */
export function formatBirthday(birthday) {
  const value = normaliseBirthday(birthday?.day, birthday?.month);
  return value ? `${value.day} ${MONTHS[value.month - 1]}` : "";
}

/**
 * Which day a birthday is actually celebrated on in a given year.
 *
 * 29 February exists in one year out of four, and somebody born on it should
 * not be skipped for the other three. It is moved to the 28th rather than to
 * 1 March: the same month is the closer reading of "the end of February", and
 * it keeps the greeting inside the right month.
 */
export function celebratedDayInYear(birthday, year) {
  const value = normaliseBirthday(birthday?.day, birthday?.month);
  if (!value) return null;

  const available = daysInMonth(value.month, year);
  return { month: value.month, day: Math.min(value.day, available) };
}

/**
 * Is it this person's birthday, where they are, at this instant?
 *
 * `zone` is their stored IANA zone; an absent or unusable one falls back to
 * UTC, which is late for most of the world but never wrong twice.
 */
export function isBirthdayNow(birthday, { now = new Date(), zone = null } = {}) {
  const parts = localDateParts(now, zone);
  if (!parts) return false;

  const celebrated = celebratedDayInYear(birthday, parts.year);
  if (!celebrated) return false;

  return parts.month === celebrated.month && parts.day === celebrated.day;
}

/**
 * Should this person be granted their birthday rank right now?
 *
 * Separate from isBirthdayNow because the job runs hourly -- it has to, since
 * midnight arrives at 24 different instants -- and must not grant again on
 * every run. `lastGrantedYear` is the local year it last fired for them.
 */
export function shouldGrantBirthday(user, { now = new Date() } = {}) {
  const birthday = normaliseBirthday(user?.birthdayDay, user?.birthdayMonth);
  if (!birthday) return false;

  const parts = localDateParts(now, user?.timezone);
  if (!parts) return false;

  if (Number(user?.birthdayLastGrantedYear) === parts.year) return false;

  return isBirthdayNow(birthday, { now, zone: user?.timezone });
}
