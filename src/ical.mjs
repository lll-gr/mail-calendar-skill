import ical from 'ical-generator';
import ICAL from 'ical.js';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { DateTime, Duration } from 'luxon';
import { InputError, ConnectionFailure, isObject } from './errors.mjs';
import { parseDate } from './dates.mjs';

// Embedded VTIMEZONE definitions take precedence. For IANA TZIDs without a
// definition, use Luxon's system timezone data instead of silently treating UTC.
function readTime(time, property, timezone) {
  if (!time) return '';
  if (time.isDate) return time.toString();
  if (time.zone !== ICAL.Timezone.localTimezone) return time.toJSDate().toISOString();
  const zone = property?.getParameter('tzid') || timezone;
  const date = DateTime.fromISO(time.toString(), { zone });
  if (!date.isValid) throw new Error('Unresolved event timezone');
  return date.toISO({ suppressMilliseconds: true });
}

export function eventsFromIcs(body, timezone = 'UTC') {
  try {
    if (typeof body !== 'string' || !body.trim()) throw new Error('Missing calendar data');
    const calendar = new ICAL.Component(ICAL.parse(body));
    if (calendar.name !== 'vcalendar') throw new Error('Expected VCALENDAR');
    return calendar.getAllSubcomponents('vevent').map(component => {
      const event = new ICAL.Event(component);
      if (!event.uid || !event.startDate) throw new Error('Missing UID or DTSTART');
      const startProperty = component.getFirstProperty('dtstart');
      return {
        uid: event.uid, summary: event.summary || '',
        start: readTime(event.startDate, startProperty, timezone),
        end: readTime(event.endDate, component.getFirstProperty('dtend') || startProperty, timezone),
        all_day: event.startDate.isDate,
        timezone: event.startDate.isDate ? '' : startProperty.getParameter('tzid') || (event.startDate.zone === ICAL.Timezone.utcTimezone ? 'UTC' : timezone),
        description: event.description || '', location: event.location || '',
        url: component.getFirstPropertyValue('url') || '',
        status: component.getFirstPropertyValue('status') || '',
        rrule: component.getAllProperties('rrule').map(property => property.getFirstValue().toString()),
        recurrence_id: readTime(component.getFirstPropertyValue('recurrence-id'), component.getFirstProperty('recurrence-id'), timezone),
        alarms: component.getAllSubcomponents('valarm').map(alarm => ({
          action: alarm.getFirstPropertyValue('action') || '',
          trigger: alarm.getFirstPropertyValue('trigger')?.toString() || '',
          related: alarm.getFirstProperty('trigger')?.getParameter('related') || 'START',
        })),
      };
    });
  } catch {
    throw new ConnectionFailure('Cannot parse CalDAV event data; check the calendar data and timezone');
  }
}

export function eventTime(value) {
  const iso = value.toUpperCase();
  const dateOnly = parseDate(iso.split('T')[0]);
  if (!iso.includes('T')) return { date: dateOnly, allDay: true };
  // Luxon permits floating times and oversized offsets; our input requires a valid explicit offset.
  if (!/(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(iso)) throw new InputError(`Datetime must include a valid UTC offset: ${value}`);
  const date = DateTime.fromISO(iso, { setZone: true });
  if (!date.isValid) throw new InputError(`Invalid ISO 8601 date/time: ${value}`);
  return { date: date.toJSDate(), allDay: false };
}

export function alarmSeconds(value) {
  const duration = Duration.fromISO(value);
  const units = Object.entries(duration.toObject());
  const sign = value.startsWith('-') ? -1 : 1;
  const seconds = duration.as('seconds');
  // Relative iCalendar reminders use whole weeks/days/time, not calendar months or years.
  if (!duration.isValid || !units.length || units.some(([unit, amount]) => !['weeks', 'days', 'hours', 'minutes', 'seconds'].includes(unit) || !Number.isInteger(amount) || amount * sign < 0) || !Number.isSafeInteger(seconds)) {
    throw new InputError(`Unsupported alarm trigger: ${value}`);
  }
  return seconds;
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
