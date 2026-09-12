import { ImapFlow } from 'imapflow';
import { MailParser } from 'mailparser';
import { htmlToText } from 'html-to-text';
import { DateTime } from 'luxon';
import { ConnectionFailure, NotFoundError, InputError, MailCalError, normalizeUid } from './errors.mjs';
import { parseSince } from './dates.mjs';
import { StateStore, mailboxKey } from './state.mjs';

export function imapOptions(settings) {
  return {
    host: settings.host, port: settings.port, secure: settings.security === 'ssl',
    ...(settings.security === 'ssl' ? {} : { doSTARTTLS: settings.security === 'starttls' }),
    auth: settings.auth === 'xoauth2' ? { user: settings.address, accessToken: settings.secret } : { user: settings.address, pass: settings.secret },
    logger: false, disableAutoIdle: true, connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 30000,
  };
}

export async function withImap(settings, operation, Client = ImapFlow) {
  const client = new Client(imapOptions(settings));
  // EventEmitter errors must be handled even outside a pending command.
  client.on('error', () => {});
  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    if (error instanceof MailCalError) throw error;
    // Do not expose protocol/library error payloads, which may include credentials.
    throw new ConnectionFailure(`IMAP operation failed (${error.code ?? 'connection or authentication error'})`);
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

export function searchCriteria(args, incremental = false) {
  const criteria = { since: parseSince(args.since) };
  if (!incremental) {
    if (args.unseen) criteria.seen = false;
    for (const [key, value] of [['subject', args.subject], ['from', args.from]]) {
      if (value === undefined) continue;
      if (/[\r\n]/.test(value)) throw new InputError('IMAP search text cannot contain newlines');
      criteria[key] = value;
    }
  }
  return criteria;
}

export async function parseMessage(raw, uid) {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({ skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true });
    const result = { uid: String(uid), message_id: '', subject: '', from: '', to: '', date: '', text: '', attachments: [] };
    parser.on('error', () => reject(new ConnectionFailure('Cannot parse message data')));
    parser.on('headers', headers => {
      result.message_id = headers.get('message-id') ?? '';
      result.subject = headers.get('subject') ?? '';
      result.from = headers.get('from')?.text ?? '';
      result.to = headers.get('to')?.text ?? '';
      const date = headers.get('date');
      result.date = date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
    });
    parser.on('headerLines', lines => {
      const line = lines.find(line => line.key === 'date')?.line ?? '';
      const rawDate = line.slice(line.indexOf(':') + 1).trim();
      // MailParser returns a JS Date without the original offset; Luxon retains it and handles folding/comments.
      const date = DateTime.fromRFC2822(rawDate, { setZone: true });
      result.date = date.isValid ? date.toISO({ suppressMilliseconds: true }) : rawDate;
    });
    parser.on('data', item => {
      if (item.type === 'text') result.text = (item.text || (item.html ? htmlToText(item.html) : '')).trim();
      if (item.type === 'attachment') {
        const attachment = { filename: item.filename ?? '', content_type: item.contentType, size: 0 };
        result.attachments.push(attachment);
        item.content.on('data', chunk => { attachment.size += chunk.length; });
        item.content.on('error', () => reject(new ConnectionFailure('Cannot parse attachment metadata')));
        item.content.on('end', () => item.release());
      }
    });
    parser.on('end', () => resolve(result));
    parser.end(raw);
  });
}

async function openMailbox(client, folder) {
  let mailbox;
  try { mailbox = await client.mailboxOpen(folder, { readOnly: true }); }
  catch (error) {
    if (error.responseStatus === 'NO') throw new NotFoundError(`Cannot open mail folder: ${folder}`);
    throw error;
  }
  if (!mailbox.uidValidity) throw new ConnectionFailure('IMAP server did not report UIDVALIDITY');
  return String(mailbox.uidValidity);
}

const HEADER_FIELDS = ['MESSAGE-ID', 'SUBJECT', 'FROM', 'TO', 'DATE'];
// A single sequence set has to stay within the server's command line limit (Dovecot
// rejects anything past 64 KB by default), so headers are requested in bounded batches.
const HEADER_BATCH = 200;

// Returns a Map keyed by canonical UID string. UID FETCH does not promise reply
// ordering and the server can interleave unrelated FETCH responses, so the result is
// indexed by the UID the response carries and never by position.
async function fetchHeaders(client, uids) {
  const requested = new Set(uids);
  const headers = new Map();
  for (let index = 0; index < uids.length; index += HEADER_BATCH) {
    const batch = uids.slice(index, index + HEADER_BATCH);
    for (const message of await client.fetchAll(batch.join(','), { headers: HEADER_FIELDS }, { uid: true })) {
      const uid = String(message.uid);
      if (!requested.has(uid) || !message.headers) continue;
      const { text, attachments, ...header } = await parseMessage(message.headers, uid);
      headers.set(uid, header);
    }
  }
  return headers;
}

export const imapFolders = settings => withImap(settings, async client => (await client.list()).map(folder => ({ name: folder.path, raw: `(${[...folder.flags].join(' ')}) "${folder.delimiter ?? ''}" "${folder.path}"` })));

export const imapSearch = (settings, args, Client = ImapFlow) => withImap(settings, async client => {
  await openMailbox(client, args.folder);
  const uids = (await client.search(searchCriteria(args), { uid: true }) || []).slice(-args.limit).map(normalizeUid);
  const headers = await fetchHeaders(client, uids);
  // Newest first, skipping any message the server did not return.
  return uids.reverse().map(uid => headers.get(uid)).filter(Boolean);
}, Client);

export const imapGet = (settings, folder, rawUid) => withImap(settings, async client => {
  const uid = normalizeUid(rawUid);
  await openMailbox(client, folder);
  const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!fetched || !fetched.source) throw new NotFoundError(`Message UID not found: ${uid}`);
  return parseMessage(fetched.source, uid);
});

export const imapPending = (settings, args, statePath, Client = ImapFlow) => withImap(settings, async client => {
  const store = new StateStore(statePath);
  const key = mailboxKey(settings);
  const validity = await openMailbox(client, args.folder);
  const before = store.cursor(key, args.folder, validity);
  const uids = (await client.search(searchCriteria(args, true), { uid: true }) || [])
    .filter(uid => uid > before).sort((a, b) => a - b).slice(0, args.scanLimit).map(normalizeUid);
  const headers = await fetchHeaders(client, uids);
  const discovered = [];
  let after = before;
  for (const uid of uids) {
    // A missing header stops the scan rather than being skipped: the cursor must not
    // advance past a gap, or the messages beyond it would never be discovered.
    const header = headers.get(uid);
    if (!header) break;
    discovered.push(header);
    after = Number(uid);
  }
  if (discovered.length || before === 0) store.recordDiscovered(key, args.folder, validity, discovered, after);
  return { folder: args.folder, uidvalidity: validity, cursor_before: before, cursor_after: after, discovered: discovered.length, pending: store.pending(key, args.folder, validity, args.limit) };
}, Client);
