import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { imapOptions, withImap, parseMessage, imapPending, searchCriteria } from '../src/imap.mjs';
import { parseSince } from '../src/dates.mjs';
import { StateStore, mailboxKey } from '../src/state.mjs';
import { InputError, ConnectionFailure } from '../src/errors.mjs';
import { header, rawMessage, settings, temporaryDirectory } from './support.mjs';

test('TLS, STARTTLS, plain and OAuth settings map to ImapFlow without logging secrets', () => {
  const mail = { ...settings().mail, secret: 'synthetic-token' };
  assert.equal(imapOptions(mail).secure, true);
  assert.equal(imapOptions(mail).logger, false);
  assert.equal(imapOptions({ ...mail, security: 'starttls' }).doSTARTTLS, true);
  assert.equal(imapOptions({ ...mail, security: 'plain' }).doSTARTTLS, false);
  assert.deepEqual(imapOptions({ ...mail, auth: 'xoauth2' }).auth, { user: mail.address, accessToken: mail.secret });
});

test('relative dates and incremental criteria avoid filtering away unseen messages', () => {
  const now = new Date(2026, 8, 12, 12);
  assert.equal(parseSince('7d', now).toISOString().slice(0, 10), '2026-09-05');
  assert.equal(parseSince('2w', now).toISOString().slice(0, 10), '2026-08-29');
  assert.equal(parseSince('2026-09-01').toISOString().slice(0, 10), '2026-09-01');
  assert.throws(() => parseSince('2026-02-30'), InputError);
  const args = { since: '30d', unseen: true, subject: 'Meeting', from: 'hr@example.com' };
  assert.deepEqual(Object.keys(searchCriteria(args, true)), ['since']);
  assert.equal(searchCriteria(args).seen, false);
  assert.throws(() => searchCriteria({ ...args, subject: 'hello\r\nNOOP' }), InputError);
});

test('MailParser decodes Chinese, strips scripts, and returns attachment metadata', async () => {
  const message = await parseMessage(rawMessage, '42');
  assert.equal(message.subject, '会议通知');
  assert.equal(message.message_id, '<test@example.com>');
  assert.ok(message.text.includes('Interview at 14:00'));
  assert.ok(!message.text.includes('ignore()'));
  assert.equal(message.date, '2026-09-11T10:00:00+08:00');
  assert.deepEqual(message.attachments, [{ filename: 'guide.pdf', content_type: 'application/pdf', size: 3 }]);
  assert.equal((await parseMessage(header('10'), '10')).subject, 'Meeting 10');
  const midnight = await parseMessage(Buffer.from('Date: Fri, 11 Sep 2026 00:30:00 +0800\r\n\r\nTomorrow'), '43');
  assert.equal(midnight.date, '2026-09-11T00:30:00+08:00');
  for (const value of ['Fri, 11 Sep 2026 00:30:00 +0800 (CST)', 'Fri, 11 Sep 2026\r\n 00:30:00 +0800']) {
    assert.equal((await parseMessage(Buffer.from(`Date: ${value}\r\n\r\nTomorrow`), '44')).date, '2026-09-11T00:30:00+08:00');
  }
  assert.equal((await parseMessage(Buffer.from('Date: Fri, 11 Sep 2026 23:30:00 EST\r\n\r\nTomorrow'), '45')).date, '2026-09-11T23:30:00-05:00');
  assert.equal((await parseMessage(Buffer.from('Date: invalid sender date\r\n\r\nTomorrow'), '46')).date, 'invalid sender date');
});

class FakeImap extends EventEmitter {
  static uids = [10, 12];
  static failUid;
  static validity = 777n;
  static opened;
  static query;
  async connect() {}
  async logout() {}
  close() {}
  async mailboxOpen(folder, options) { FakeImap.opened = { folder, options }; return { uidValidity: FakeImap.validity }; }
  async search(query, options) { FakeImap.query = { query, options }; return FakeImap.uids; }
  async fetchOne(uid, query, options) {
    assert.deepEqual(options, { uid: true });
    assert.ok(query.headers.includes('MESSAGE-ID'));
    return Number(uid) === FakeImap.failUid ? false : { uid: Number(uid), headers: header(uid) };
  }
}

test('incremental processing preserves unacknowledged mail and stops before failed fetch', async t => {
  const path = join(temporaryDirectory(t), 'state.json');
  const mail = { ...settings().mail, secret: 'synthetic-password' };
  const args = { folder: 'INBOX', since: '30d', limit: 50, scanLimit: 200 };
  const first = await imapPending(mail, args, path, FakeImap);
  assert.equal(first.cursor_after, 12);
  assert.equal(first.discovered, 2);
  assert.deepEqual(FakeImap.opened.options, { readOnly: true });
  new StateStore(path).acknowledge(mailboxKey(mail), 'INBOX', '777', [{ uid: '10', outcome: 'ignored' }]);
  const second = await imapPending(mail, args, path, FakeImap);
  assert.equal(second.discovered, 0);
  assert.deepEqual(second.pending.map(item => item.uid), ['12']);
  FakeImap.uids = [10, 12, 14, 16];
  FakeImap.failUid = 14;
  const failed = await imapPending(mail, args, path, FakeImap);
  assert.equal(failed.cursor_after, 12);
  FakeImap.failUid = undefined;
  const resumed = await imapPending(mail, { ...args, scanLimit: 1 }, path, FakeImap);
  assert.equal(resumed.cursor_after, 14);
  assert.equal(resumed.discovered, 1);
  FakeImap.validity = 888n;
  FakeImap.uids = [1];
  const generation = await imapPending(mail, args, path, FakeImap);
  assert.equal(generation.cursor_before, 0);
  assert.deepEqual(generation.pending.map(item => item.uid), ['1']);
});

test('connection failures are JSON-safe and do not leak protocol error payloads', async () => {
  class FailedImap extends EventEmitter {
    async connect() { throw new Error('PASS synthetic-password'); }
    async logout() { throw new Error('closed'); }
    close() {}
  }
  await assert.rejects(withImap({ ...settings().mail, secret: 'synthetic-password' }, async () => {}, FailedImap), error => error instanceof ConnectionFailure && !error.message.includes('synthetic-password'));
});
