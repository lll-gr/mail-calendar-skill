import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToIcs, eventsFromIcs, alarmSeconds } from '../src/ical.mjs';
import { calendarList, calendarEvents, calendarGet, calendarCreate, calendarDelete, calendarTransport, authHeaders } from '../src/caldav.mjs';
import { InputError, ConnectionFailure, NotFoundError } from '../src/errors.mjs';
import { davServer } from './support.mjs';

const event = () => ({ source_id: '<test@example.com>#1', summary: 'Interview', start: '2026-09-15T14:00:00+08:00', end: '2026-09-15T15:00:00+08:00', alarms: ['-PT1H'] });
const calendarSettings = base => ({ base_url: base, collection_url: new URL('calendars/user/default/', base).href, auth: 'basic', username: 'person', secret: 'synthetic-password' });

test('event UID is exactly compatible with Python and times are emitted in UTC', () => {
  const result = eventToIcs(event());
  assert.equal(result.uid, '6d76f604-a314-54b2-8596-9e93c03ec984');
  assert.equal(eventToIcs(event()).uid, result.uid);
  assert.ok(result.body.includes('DTSTART:20260915T060000Z'));
  assert.ok(result.body.includes('DTEND:20260915T070000Z'));
  assert.ok(result.body.includes('TRIGGER:-PT1H'));
});

test('all-day dates keep their date and default to the next day', () => {
  const result = eventToIcs({ summary: 'Deadline', start: '2026-09-20' });
  assert.ok(result.body.includes('DTSTART;VALUE=DATE:20260920'));
  assert.ok(result.body.includes('DTEND;VALUE=DATE:20260921'));
  const monthEnd = eventToIcs({ summary: 'Deadline', start: '2026-12-31' });
  assert.ok(monthEnd.body.includes('DTEND;VALUE=DATE:20270101'));
});

test('rejects invalid dates, floating times, mixed types, reversed ends and injection in UID', () => {
  for (const start of ['2026-02-30', '2026-09-15T14:00:00', '2026-09-15T99:00:00Z', '2026-09-15T14:60:00Z', '2026-09-15T14:00:00+99:99', '2026-09-15T14:00:00+01:99', '14:00:00Z']) assert.throws(() => eventToIcs({ ...event(), start }), InputError);
  assert.throws(() => eventToIcs({ ...event(), end: '2026-09-20' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), end: '2026-09-15T13:00:00+08:00' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), uid: 'a\r\nBEGIN:VEVENT' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), alarms: 'wrong' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), status: 'wrong' }), InputError);
});

test('alarm durations and Chinese text are safely encoded and folded', () => {
  assert.equal(alarmSeconds('-P1DT2H30M'), -95400);
  assert.equal(alarmSeconds('PT1H'), 3600);
  assert.equal(alarmSeconds('-P2W'), -1209600);
  for (const value of ['P', 'PT', 'P1M', 'P1Y', 'PT1.5H', 'P1DT-2H', '-P1DT-2H', 'PT999999999999999999S']) assert.throws(() => alarmSeconds(value), InputError);
  const result = eventToIcs({ ...event(), summary: '会议'.repeat(60), description: 'line 1\nline 2; test, value' });
  assert.ok(result.body.includes('DESCRIPTION:line 1\\nline 2\\; test\\, value'));
  for (const line of result.body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
});

for (const options of [{}, { redirect: true }, { missingWellKnown: true }]) {
  test(`tsdav discovers calendars over real HTTP: ${JSON.stringify(options)}`, async t => {
    const server = await davServer(t, options);
    const result = await calendarList(calendarSettings(server.base));
    assert.deepEqual(result, [{ name: 'Work & Meetings', url: new URL('calendars/user/default/', server.base).href }]);
    assert.equal(server.requests[0].url, '/.well-known/caldav');
    assert.ok(server.requests.every(request => request.headers.authorization === new Headers(authHeaders(calendarSettings(server.base))).get('authorization')));
    if (options.redirect) assert.equal(server.requests[1].method, 'PROPFIND');
  });
}

test('tsdav falls back to the configured service path when well-known is missing', async t => {
  const server = await davServer(t, { missingWellKnown: true });
  await calendarList({ ...calendarSettings(server.base), base_url: new URL('/dav/', server.base).href });
  assert.ok(server.requests.some(request => request.url === '/dav/' && request.body.includes('current-user-principal')));
});

test('a nonstandard service without a principal returns a clear discovery error', async t => {
  const server = await davServer(t, { directHome: true });
  await assert.rejects(calendarList(calendarSettings(server.base)), ConnectionFailure);
});

test('repeated calendar create replaces the same resource, then delete removes it', async t => {
  const server = await davServer(t);
  const settings = calendarSettings(server.base);
  const first = await calendarCreate(settings, event());
  const second = await calendarCreate(settings, { ...event(), description: 'updated' });
  assert.equal(first.uid, second.uid);
  assert.equal(first.url, second.url);
  assert.equal(first.http_status, 201);
  assert.equal(second.http_status, 204);
  assert.equal(first.etag, '"v1"');
  assert.equal(server.events.size, 1);
  assert.ok([...server.events.values()][0].includes('DESCRIPTION:updated'));
  assert.ok(server.requests.every(request => !request.headers['if-none-match']));
  assert.equal((await calendarDelete(settings, first.uid)).deleted, true);
  assert.equal(server.events.size, 0);
  await assert.rejects(calendarDelete(settings, first.uid), NotFoundError);
});

test('Bearer authentication and same-origin redirects preserve method and prevent credential leakage', async () => {
  const settings = { base_url: 'https://dav.example/', auth: 'bearer', secret: 'synthetic-token' };
  const calls = [];
  const transport = calendarTransport(settings, async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response('', { status: 307, headers: { Location: '/dav/' } }) : new Response('', { status: 207 });
  });
  await transport('https://dav.example/', { method: 'PROPFIND', body: '<xml/>' });
  assert.equal(calls[1].options.method, 'PROPFIND');
  assert.equal(calls[1].options.body, '<xml/>');
  assert.equal(calls[1].options.headers.get('authorization'), 'Bearer synthetic-token');
  let count = 0;
  const crossOrigin = calendarTransport(settings, async () => { count++; return new Response('', { status: 302, headers: { Location: 'https://other.example/' } }); });
  await assert.rejects(crossOrigin(settings.base_url), ConnectionFailure);
  assert.equal(count, 1);
  await assert.rejects(crossOrigin('https://other.example/'), ConnectionFailure);
  assert.equal(count, 1);
});

const ics = lines => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');

test('iCalendar reading unfolds and decodes text, keeps all-day dates and alarms', () => {
  const data = eventsFromIcs(eventToIcs({ ...event(), uid: eventToIcs(event()).uid, summary: '会议'.repeat(60), description: 'one\ntwo; three, four', location: 'Room A', url: 'https://example.com/meeting' }).body);
  assert.equal(data[0].uid, eventToIcs(event()).uid);
  assert.equal(data[0].summary, '会议'.repeat(60));
  assert.equal(data[0].description, 'one\ntwo; three, four');
  assert.equal(data[0].location, 'Room A');
  assert.equal(data[0].url, 'https://example.com/meeting');
  assert.equal(data[0].start, '2026-09-15T06:00:00.000Z');
  assert.deepEqual(data[0].alarms, [{ action: 'DISPLAY', trigger: '-PT1H', related: 'START' }]);
  const allDay = eventsFromIcs(eventToIcs({ summary: 'Deadline', start: '2026-12-31' }).body)[0];
  assert.equal(allDay.start, '2026-12-31');
  assert.equal(allDay.end, '2027-01-01');
  assert.equal(allDay.all_day, true);
});

test('reads floating and IANA times, duration, recurrence rules and overridden instances', () => {
  const data = eventsFromIcs(ics([
    'BEGIN:VEVENT', 'UID:series', 'DTSTART;TZID=Asia/Shanghai:20260915T140000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=4', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series', 'DTSTART:20260922T150000', 'RECURRENCE-ID;TZID=Asia/Shanghai:20260922T140000', 'END:VEVENT',
  ]), 'Asia/Shanghai');
  assert.equal(data[0].start, '2026-09-15T14:00:00+08:00');
  assert.equal(data[0].end, '2026-09-15T15:00:00+08:00');
  assert.deepEqual(data[0].rrule, ['FREQ=WEEKLY;COUNT=4']);
  assert.equal(data[1].start, '2026-09-22T15:00:00+08:00');
  assert.equal(data[1].recurrence_id, '2026-09-22T14:00:00+08:00');
  assert.equal(data[1].end, data[1].start);
});

test('embedded timezone definitions override IANA fallback', () => {
  const data = eventsFromIcs(ics([
    'BEGIN:VTIMEZONE', 'TZID:Custom/Office', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:custom', 'DTSTART;TZID=Custom/Office:20260915T140000', 'END:VEVENT',
  ]));
  assert.equal(data[0].start, '2026-09-15T08:30:00.000Z');
  assert.equal(data[0].timezone, 'Custom/Office');
});

test('event reading rejects malformed calendars and unresolved timezones', () => {
  for (const body of ['', '<html>error</html>', ics(['BEGIN:VEVENT', 'UID:no-start', 'END:VEVENT']), ics(['BEGIN:VEVENT', 'UID:bad-zone', 'DTSTART;TZID=Unknown/Zone:20260915T140000', 'END:VEVENT'])]) {
    assert.throws(() => eventsFromIcs(body), ConnectionFailure);
  }
});

test('reads event ranges and details over HTTP without modifying resources', async t => {
  const server = await davServer(t);
  const settings = { ...calendarSettings(server.base), timezone: 'Asia/Shanghai' };
  const created = await calendarCreate(settings, event());
  await calendarCreate(settings, { uid: 'earlier', summary: 'Other', start: '2026-09-15T09:00:00+08:00', end: '2026-09-15T10:00:00+08:00' });
  // External clients are free to use filenames unrelated to the event UID.
  server.events.set('/calendars/user/default/external.ics', eventToIcs({ uid: 'external-uid', summary: 'External', start: '2026-09-15' }).body);
  const before = [...server.events];
  server.requests.length = 0;
  const result = await calendarEvents(settings, { start: '2026-09-15', end: '2026-09-16', limit: 2 });
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.events.map(item => item.uid), ['external-uid', 'earlier']);
  assert.ok(server.requests[0].body.includes('start="20260914T160000Z"'));
  assert.ok(server.requests[0].body.includes('end="20260915T160000Z"'));
  assert.match(server.requests[0].body, /<c:expand/);
  const filtered = await calendarEvents(settings, { start: '2026-09-15', end: '2026-09-16', summary: 'interVIEW' });
  assert.equal(filtered.events[0].resource_url, created.url);
  assert.equal((await calendarEvents(settings, { start: '2027-01-01', end: '2027-02-01' })).total, 0);
  const byUid = await calendarGet(settings, 'external-uid');
  assert.ok(byUid.url.endsWith('/external.ics'));
  assert.equal(byUid.events[0].all_day, true);
  const byUrl = await calendarGet(settings, undefined, created.url);
  assert.equal(byUrl.etag, '"v1"');
  assert.equal(byUrl.events[0].summary, 'Interview');
  assert.ok(byUrl.ical.includes('BEGIN:VCALENDAR'));
  assert.deepEqual([...server.events], before);
  assert.ok(server.requests.every(request => ['REPORT', 'GET'].includes(request.method)));
  await assert.rejects(calendarGet(settings, 'missing'), NotFoundError);
  await assert.rejects(calendarGet(settings, undefined, new URL('missing.ics', settings.collection_url).href), NotFoundError);
});

test('validates event ranges and required get identifiers before making requests', async () => {
  const settings = calendarSettings('https://dav.example/');
  const fetch = () => { throw new Error('Must not reach transport'); };
  for (const args of [{}, { start: '2026-02-30', end: '2026-03-01' }, { start: '2026-09-16', end: '2026-09-15' }, { start: '2026-09-15', end: '2026-09-15' }, { start: '2026-09-15T14:00:00', end: '2026-09-16' }, { start: '2026-09-15', end: '2026-09-16', limit: 0 }]) {
    await assert.rejects(calendarEvents(settings, args, fetch), InputError);
  }
  await assert.rejects(calendarGet(settings, undefined, undefined, undefined, fetch), InputError);
  await assert.rejects(calendarGet(settings, undefined, 'https://other.example/event.ics', undefined, fetch), ConnectionFailure);
});

const report = body => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/user/default/series</d:href><d:propstat><d:prop><d:getetag>series-etag</d:getetag><c:calendar-data><![CDATA[${body}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207, headers: { 'Content-Type': 'application/xml' } });

test('range results include multiple server-expanded occurrences from a resource without an .ics suffix', async () => {
  const settings = calendarSettings('https://dav.example/');
  const body = ics([
    'BEGIN:VEVENT', 'UID:series', 'SUMMARY:Weekly', 'DTSTART:20260915T060000Z', 'DTEND:20260915T070000Z', 'RECURRENCE-ID:20260915T060000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series', 'SUMMARY:Rescheduled', 'DTSTART:20260922T080000Z', 'DTEND:20260922T090000Z', 'RECURRENCE-ID:20260922T060000Z', 'END:VEVENT',
  ]);
  const result = await calendarEvents(settings, { start: '2026-09-01', end: '2026-10-01' }, async () => report(body));
  assert.equal(result.total, 2);
  assert.equal(result.events[1].summary, 'Rescheduled');
  assert.equal(result.events[1].recurrence_id, '2026-09-22T06:00:00.000Z');
  assert.ok(result.events.every(item => item.resource_url.endsWith('/series') && item.etag === 'series-etag'));
});

test('unsupported REPORT, missing report data and unexpanded recurrence fail clearly', async () => {
  const settings = calendarSettings('https://dav.example/');
  const args = { start: '2026-09-01', end: '2026-10-01' };
  await assert.rejects(calendarEvents(settings, args, async () => new Response('', { status: 405 })), ConnectionFailure);
  await assert.rejects(calendarEvents(settings, args, async () => new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/bad.ics</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response></d:multistatus>', { status: 207, headers: { 'Content-Type': 'application/xml' } })), ConnectionFailure);
  const series = ics(['BEGIN:VEVENT', 'UID:series', 'DTSTART:20200101T060000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT']);
  await assert.rejects(calendarEvents(settings, args, async () => report(series)), /did not expand/);
  assert.deepEqual((await calendarGet(settings, 'series', undefined, undefined, async () => report(series))).events[0].rrule, ['FREQ=WEEKLY']);
});

test('UID filters escape XML and resolve external filenames', async t => {
  const server = await davServer(t);
  const settings = calendarSettings(server.base);
  const uid = 'event&<special>';
  server.events.set('/calendars/user/default/external.ics', eventToIcs({ uid, summary: 'Special', start: '2026-09-15' }).body);
  const result = await calendarGet(settings, uid);
  assert.equal(result.events[0].uid, uid);
  assert.ok(server.requests[0].body.includes('event&amp;&lt;special&gt;'));
});
