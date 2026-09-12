import ical from 'ical-generator';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { InputError, isObject } from './errors.mjs';

export function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InputError(`Invalid ISO 8601 date: ${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new InputError(`Invalid ISO 8601 date: ${value}`);
  return date;
}

export function eventTime(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: parseDate(value), allDay: true };
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new InputError(`Datetime must include a UTC offset: ${value}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new InputError(`Invalid ISO 8601 date/time: ${value}`);
  }
  parseDate(value.slice(0, 10));
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new InputError(`Invalid ISO 8601 date/time: ${value}`);
  return { date, allDay: false };
}

export function alarmSeconds(value) {
  const valid = /^-?P(?:\d+W|\d+D(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?|T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)$/;
  if (!valid.test(value)) throw new InputError(`Unsupported alarm trigger: ${value}`);
  const amount = unit => Number(value.match(new RegExp(`(\\d+)${unit}`))?.[1] ?? 0);
  const seconds = amount('W') * 604800 + amount('D') * 86400 + amount('H') * 3600 + amount('M') * 60 + amount('S');
  if (!Number.isSafeInteger(seconds)) throw new InputError(`Unsupported alarm trigger: ${value}`);
  return value.startsWith('-') ? -seconds : seconds;
}

export function eventToIcs(data) {
  if (!isObject(data)) throw new InputError('Event JSON must be an object');
  const summary = String(data.summary ?? '').trim();
  const startValue = String(data.start ?? '').trim();
  if (!summary || !startValue) throw new InputError('Event requires non-empty summary and start');
  const sourceId = String(data.source_id ?? '').trim();
  const uid = String(data.uid ?? '').trim() || (sourceId ? uuidv5([sourceId, summary, startValue].join('\x1f'), uuidv5.URL) : uuidv4());
  if (/[\r\n]/.test(uid)) throw new InputError('Event UID cannot contain newlines');
  const start = eventTime(startValue);
  const endValue = String(data.end ?? '').trim();
  let end;
  if (endValue) {
    end = eventTime(endValue);
    if (start.allDay !== end.allDay) throw new InputError('Event start and end must both be dates or both be datetimes');
    if (end.date <= start.date) throw new InputError('Event end must be after start');
  } else if (start.allDay) {
    end = { date: new Date(start.date), allDay: true };
    end.date.setUTCDate(end.date.getUTCDate() + 1);
  }
  const status = String(data.status ?? 'CONFIRMED').toUpperCase();
  if (!['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(status)) throw new InputError('Event status must be CONFIRMED, TENTATIVE, or CANCELLED');
  const alarms = data.alarms ?? [];
  if (!Array.isArray(alarms)) throw new InputError('Event alarms must be an array');
  const triggers = alarms.map(value => alarmSeconds(String(value)));
  try {
    const calendar = ical({ prodId: '-//mail-calendar//mailcal//EN' });
    const event = calendar.createEvent({
      id: uid, start: start.date, end: end?.date ?? null, allDay: start.allDay,
      summary, status,
      description: String(data.description ?? '').trim(),
      location: String(data.location ?? '').trim(),
      url: String(data.url ?? '').trim().replace(/[\r\n]/g, '') || null,
    });
    for (const seconds of triggers) event.createAlarm({ type: 'display', trigger: -seconds });
    return { uid, body: calendar.toString() };
  } catch (error) {
    throw new InputError(`Cannot generate event: ${error.message}`);
  }
}
