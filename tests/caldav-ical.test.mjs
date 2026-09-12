import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToIcs, alarmSeconds } from '../src/ical.mjs';
import { calendarList, calendarCreate, calendarDelete, calendarTransport, authHeaders } from '../src/caldav.mjs';
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
  for (const start of ['2026-02-30', '2026-09-15T14:00:00', '2026-09-15T99:00:00Z']) assert.throws(() => eventToIcs({ ...event(), start }), InputError);
  assert.throws(() => eventToIcs({ ...event(), end: '2026-09-20' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), end: '2026-09-15T13:00:00+08:00' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), uid: 'a\r\nBEGIN:VEVENT' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), alarms: 'wrong' }), InputError);
  assert.throws(() => eventToIcs({ ...event(), status: 'wrong' }), InputError);
});

test('alarm durations and Chinese text are safely encoded and folded', () => {
  assert.equal(alarmSeconds('-P1DT2H30M'), -95400);
  assert.equal(alarmSeconds('PT1H'), 3600);
  assert.throws(() => alarmSeconds('P'), InputError);
  const result = eventToIcs({ ...event(), summary: '会议'.repeat(60), description: 'line 1\nline 2; test, value' });
  assert.ok(result.body.includes('DESCRIPTION:line 1\\nline 2\\; test\\, value'));
  for (const line of result.body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
});

for (const options of [{}, { redirect: true }, { missingWellKnown: true }, { directHome: true }]) {
  test(`tsdav discovers calendars over real HTTP: ${JSON.stringify(options)}`, async t => {
    const server = await davServer(t, options);
    const result = await calendarList(calendarSettings(server.base));
    assert.deepEqual(result, [{ name: 'Work & Meetings', url: new URL('calendars/user/default/', server.base).href }]);
    assert.equal(server.requests[0].url, '/.well-known/caldav');
    assert.ok(server.requests.every(request => request.headers.authorization === authHeaders(calendarSettings(server.base)).Authorization));
    if (options.redirect) assert.equal(server.requests[1].method, 'PROPFIND');
  });
}

test('explicit service paths take precedence over well-known discovery', async t => {
  const server = await davServer(t);
  await calendarList({ ...calendarSettings(server.base), base_url: new URL('/dav/', server.base).href });
  assert.equal(server.requests[0].url, '/dav/');
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
