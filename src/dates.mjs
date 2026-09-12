import { DateTime } from 'luxon';
import { InputError } from './errors.mjs';

export function parseDate(value) {
  const date = DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'utc' });
  if (!date.isValid || date.toISODate() !== value) throw new InputError(`Invalid ISO 8601 date: ${value}`);
  return date.toJSDate();
}

export function parseSince(value, now = new Date()) {
  const text = value.trim();
  const relative = text.match(/^(\d+)([dw])$/i);
  if (!relative) {
    try { return parseDate(text); } catch { throw new InputError('--since must be YYYY-MM-DD, Nd, or Nw'); }
  }
  const days = Number(relative[1]) * (relative[2].toLowerCase() === 'w' ? 7 : 1);
  // Relative ranges count back from today's local calendar date, read as UTC midnight:
  // IMAP SINCE compares whole days, so a wall-clock zone here would shift the boundary.
  const date = DateTime.fromObject(
    { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    { zone: 'utc' },
  ).minus({ days }).toJSDate();
  if (!Number.isFinite(date.getTime())) throw new InputError('Invalid --since range');
  return date;
}
