import { createDAVClient, getBasicAuthHeaders, getBearerAuthHeaders, updateCalendarObject, deleteCalendarObject } from 'tsdav';
import { eventToIcs } from './ical.mjs';
import { ConfigError, ConnectionFailure, NotFoundError, InputError, MailCalError } from './errors.mjs';
import { VERSION } from './version.mjs';

export function authHeaders(settings) {
  if (settings.auth === 'basic') return getBasicAuthHeaders({ username: settings.username, password: settings.secret });
  if (settings.auth === 'bearer') return getBearerAuthHeaders({ accessToken: settings.secret });
  throw new ConfigError(`Unsupported CalDAV auth mode: ${settings.auth}`);
}

export function calendarTransport(settings, fetchImpl = globalThis.fetch) {
  const origin = new URL(settings.base_url).origin;
  return async (input, init = {}) => {
    let url = new URL(input);
    const timeout = AbortSignal.timeout(30000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      for (let count = 0; count < 6; count++) {
        if (url.origin !== origin || url.username || url.password) throw new ConnectionFailure('CalDAV URL uses a different origin; configure its base URL first');
        const headers = new Headers(init.headers);
        for (const [key, value] of Object.entries(authHeaders(settings))) headers.set(key, value);
        headers.set('User-Agent', `mailcal/${VERSION}`);
        const response = await fetchImpl(url.href, { ...init, headers, signal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new ConnectionFailure('CalDAV redirect has no Location header');
          const target = new URL(location, url);
          if (target.origin !== origin || target.username || target.password) throw new ConnectionFailure('CalDAV redirected to a different origin; configure its base URL first');
          // tsdav's service discovery consumes redirects itself.
          if (init.redirect === 'manual') return response;
          await response.body?.cancel();
          url = target;
          continue;
        }
        if (response.status === 404) { await response.body?.cancel(); throw new NotFoundError(`CalDAV resource not found: ${url.href}`); }
        if (!response.ok) { await response.body?.cancel(); throw new ConnectionFailure(`CalDAV ${init.method ?? 'GET'} failed with HTTP ${response.status}`); }
        return response;
      }
      throw new ConnectionFailure('CalDAV exceeded the redirect limit');
    } catch (error) {
      if (error instanceof MailCalError) throw error;
      throw new ConnectionFailure(`CalDAV request failed (${error.cause?.code ?? error.code ?? 'connection error'}); check connectivity and server configuration`);
    }
  };
}

export async function calendarList(settings, fetchImpl = globalThis.fetch) {
  try {
    const client = await createDAVClient({
      serverUrl: settings.base_url,
      defaultAccountType: 'caldav',
      authMethod: settings.auth === 'basic' ? 'Basic' : 'Bearer',
      credentials: settings.auth === 'basic' ? { username: settings.username, password: settings.secret } : { accessToken: settings.secret },
      fetch: calendarTransport(settings, fetchImpl),
    });
    const calendars = await client.fetchCalendars();
    return calendars.map(calendar => ({ name: typeof calendar.displayName === 'string' && calendar.displayName ? calendar.displayName : new URL(calendar.url).pathname.replace(/\/$/, '').split('/').at(-1), url: calendar.url }));
  } catch (error) {
    if (error instanceof MailCalError) throw error;
    throw new ConnectionFailure('CalDAV discovery failed; check the server URL and credentials');
  }
}

export function calendarUrl(settings, override) {
  const url = override || settings.collection_url;
  if (!url) throw new ConfigError("Calendar collection URL is missing. Run 'calendar list' or pass --calendar-url.");
  try { return new URL(String(url).replace(/\/$/, '') + '/').href; }
  catch { throw new InputError('Invalid calendar collection URL'); }
}

const resourceUrl = (collection, uid) => collection + encodeURIComponent(uid).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) + '.ics';

export async function calendarCreate(settings, data, override, fetchImpl = globalThis.fetch) {
  const { uid, body } = eventToIcs(data);
  const url = resourceUrl(calendarUrl(settings, override), uid);
  // An unconditional PUT preserves the previous create-or-replace behavior.
  // tsdav's createCalendarObject uses If-None-Match and would reject repeats.
  const response = await updateCalendarObject({ calendarObject: { url, data: body }, fetch: calendarTransport(settings, fetchImpl) });
  await response.body?.cancel();
  return { uid, url, http_status: response.status, etag: response.headers.get('etag') ?? '' };
}

export async function calendarDelete(settings, uid, url, override, fetchImpl = globalThis.fetch) {
  if (!uid && !url) throw new InputError('calendar delete requires --uid or --url');
  const target = url || resourceUrl(calendarUrl(settings, override), uid);
  const response = await deleteCalendarObject({ calendarObject: { url: target }, fetch: calendarTransport(settings, fetchImpl) });
  await response.body?.cancel();
  return { uid: uid || '', url: target, http_status: response.status, deleted: true };
}
