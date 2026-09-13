import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

export function temporaryDirectory(t) {
  const path = mkdtempSync(join(tmpdir(), 'mailcal-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
export const settings = () => ({
  version: 1, timezone: 'Asia/Shanghai',
  mail: { address: 'person@example.com', host: 'imap.example.com', port: 993, security: 'ssl', auth: 'password' },
  calendar: { base_url: 'https://dav.example/', auth: 'basic', username: 'person' },
});
export const credentials = () => ({ version: 1, mail: { secret: 'synthetic-mail-secret' }, calendar: { secret: 'synthetic-calendar-secret' } });
export const header = uid => Buffer.from(`From: HR <hr@example.com>\r\nTo: User <user@example.com>\r\nSubject: Meeting ${uid}\r\nMessage-ID: <m${uid}@example.com>\r\nDate: Fri, 11 Sep 2026 10:00:00 +0800\r\n\r\n`);
export const rawMessage = Buffer.from(
  'From: HR <hr@example.com>\r\nTo: User <user@example.com>\r\n' +
  'Subject: =?UTF-8?B?5Lya6K6u6YCa55+l?=\r\nMessage-ID: <test@example.com>\r\n' +
  'Date: Fri, 11 Sep 2026 10:00:00 +0800\r\nMIME-Version: 1.0\r\n' +
  'Content-Type: multipart/mixed; boundary=x\r\n\r\n' +
  '--x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
  '<p>Interview at <b>14:00</b></p><script>ignore()</script>\r\n' +
  '--x\r\nContent-Type: application/pdf\r\n' +
  'Content-Disposition: attachment; filename=guide.pdf\r\n\r\nPDF\r\n--x--\r\n'
);

const multistatus = (href, props) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
const xmlEscape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function davServer(t, { redirect = false, missingWellKnown = false, directHome = false } = {}) {
  const requests = [];
  const events = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    if (request.url === '/.well-known/caldav' && missingWellKnown) { response.writeHead(404).end(); return; }
    if (request.url === '/.well-known/caldav' && redirect) { response.writeHead(301, { Location: '/dav/' }).end(); return; }
    if (request.url.endsWith('.ics')) {
      if (request.method === 'PUT') {
        const exists = events.has(request.url);
        events.set(request.url, body);
        response.writeHead(exists ? 204 : 201, { ETag: '"v1"' }).end();
      } else if (request.method === 'DELETE') {
        response.writeHead(events.delete(request.url) ? 204 : 404).end();
      } else if (request.method === 'GET' && events.has(request.url)) {
        response.writeHead(200, { 'Content-Type': 'text/calendar', ETag: '"v1"' }).end(events.get(request.url));
      } else response.writeHead(404).end();
      return;
    }
    if (request.method === 'REPORT') {
      const uid = body.match(/<[^>]*text-match[^>]*>([^<]*)<\//)?.[1];
      const rangeStart = body.match(/start="([^"]+)"/)?.[1];
      const rangeEnd = body.match(/end="([^"]+)"/)?.[1];
      const items = [...events].filter(([, data]) => {
        if (uid) return xmlEscape(data.match(/\r\nUID:(.*)\r\n/)?.[1] || '') === uid;
        const start = data.match(/DTSTART(?:;VALUE=DATE)?:([0-9TZ]+)/)?.[1];
        const end = data.match(/DTEND(?:;VALUE=DATE)?:([0-9TZ]+)/)?.[1] || start;
        return !rangeStart || (start < rangeEnd && (end > rangeStart || start === end && start >= rangeStart));
      });
      const responses = items.map(([href, data]) => multistatus(xmlEscape(href), `<d:getetag>&quot;v1&quot;</d:getetag><c:calendar-data>${xmlEscape(data)}</c:calendar-data>`).match(/<d:response>.*<\/d:response>/s)[0]).join('');
      response.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`);
      return;
    }
    response.writeHead(207, { 'Content-Type': 'application/xml' });
    if (body.includes('supported-report-set')) response.end(multistatus(request.url, '<d:supported-report-set/>'));
    else if (request.url === '/calendars/user/') response.end(multistatus('/calendars/user/default/', '<d:displayname>Work &amp; Meetings</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'));
    else if (request.url === '/principals/user/') response.end(multistatus(request.url, '<c:calendar-home-set><d:href>/calendars/user/</d:href></c:calendar-home-set>'));
    else response.end(multistatus(request.url, directHome ? '<c:calendar-home-set><d:href>/calendars/user/</d:href></c:calendar-home-set>' : '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}/`, requests, events };
}

// IMAP sequence sets are comma separated and may use inclusive ranges.
export const expandUidSet = set => set.split(',').flatMap(part => {
  const range = part.match(/^(\d+):(\d+)$/);
  if (!range) return [Number(part)];
  const [from, to] = [Number(range[1]), Number(range[2])];
  return Array.from({ length: Math.abs(to - from) + 1 }, (_, offset) => Math.min(from, to) + offset);
}).filter(Number.isSafeInteger);

export async function imapServer(t) {
  const commands = [];
  const sockets = new Set();
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK test IMAP server\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        commands.push(line);
        const [, tag, command = ''] = line.match(/^(\S+)\s+(.*)$/) ?? [];
        const upper = command.toUpperCase();
        if (upper === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY\r\n`);
        else if (upper.startsWith('LOGIN ')) socket.write(`${tag} OK LOGIN\r\n`);
        else if (upper.startsWith('LIST ')) socket.write(`* LIST () "/" "${upper.endsWith('""') ? '' : 'INBOX'}"\r\n${tag} OK LIST\r\n`);
        else if (upper.startsWith('LSUB ')) socket.write(`${tag} OK LSUB\r\n`);
        else if (upper.startsWith('EXAMINE ') || upper.startsWith('SELECT ')) socket.write(`* FLAGS (\\Seen)\r\n* 2 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 777] UIDs\r\n* OK [UIDNEXT 13] next\r\n${tag} OK [READ-ONLY] EXAMINE\r\n`);
        else if (upper.startsWith('UID SEARCH ')) socket.write(`* SEARCH 10 12\r\n${tag} OK SEARCH\r\n`);
        else if (upper.startsWith('UID FETCH ')) {
          const set = command.match(/^UID FETCH ([0-9,:*]+)/i)?.[1] ?? '10';
          const wantsHeaders = upper.includes('HEADER.FIELDS');
          const section = wantsHeaders ? 'HEADER.FIELDS (MESSAGE-ID SUBJECT FROM TO DATE)' : '';
          // One untagged FETCH per requested UID, in the order the set listed them.
          for (const uid of expandUidSet(set)) {
            const data = wantsHeaders ? header(uid) : rawMessage;
            socket.write(`* ${uid === 10 ? '1' : '2'} FETCH (UID ${uid} RFC822.SIZE ${data.length} BODY[${section}] {${data.length}}\r\n`);
            socket.write(data);
            socket.write(')\r\n');
          }
          socket.write(`${tag} OK FETCH\r\n`);
        } else if (upper === 'LOGOUT') { socket.end(`* BYE logging out\r\n${tag} OK LOGOUT\r\n`); }
        else socket.write(`${tag} OK command\r\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  return { host: '127.0.0.1', port: server.address().port, commands };
}
