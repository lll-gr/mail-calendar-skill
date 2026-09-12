import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConfigStore, configInit, storageDirectory, makePrivate, tightenWindowsAcl, validateMailSettings } from '../src/config.mjs';
import { detectMailProvider } from '../src/providers.mjs';
import { StateStore, mailboxKey } from '../src/state.mjs';
import { ConfigError, InputError, NotFoundError } from '../src/errors.mjs';
import { settings, credentials, temporaryDirectory } from './support.mjs';

test('provider detection and fixed storage directory', () => {
  assert.equal(detectMailProvider('person@qq.com'), 'qq');
  assert.equal(detectMailProvider('person@163.com'), 'netease163');
  assert.equal(detectMailProvider('person@example.com'), 'generic');
  assert.equal(storageDirectory(), join(homedir(), '.mail-calendar-skill'));
});

test('init separates credentials, refuses accidental overwrite, and reads version 1 settings', async t => {
  const store = new ConfigStore(temporaryDirectory(t));
  const secrets = ['synthetic-mail-secret', 'synthetic-calendar-secret'];
  const result = await configInit({ email: 'person@163.com', mailProvider: 'auto', calendarProvider: 'qq', calendarUser: 'person@qq.com', timezone: 'Asia/Shanghai' }, store, async () => secrets.shift());
  assert.equal(result.mail_provider, 'netease163');
  assert.equal(store.loadSettings().mail.host, 'imap.163.com');
  assert.equal(store.mail().secret, 'synthetic-mail-secret');
  assert.equal(store.calendar().secret, 'synthetic-calendar-secret');
  const shown = JSON.stringify(store.show());
  assert.equal(store.show().credentials_present, true);
  assert.ok(!shown.includes('synthetic-mail-secret') && !shown.includes('synthetic-calendar-secret'));
  assert.throws(() => store.initialize(settings(), credentials()), InputError);
  fs.writeFileSync(store.credentialsPath, 'invalid JSON');
  assert.doesNotThrow(() => store.show());
  assert.throws(() => store.mail(), ConfigError);
  store.initialize(settings(), credentials(), true);
  assert.equal(store.mail().address, 'person@example.com');
});

test('reuse secret prompts once and invalid settings fail before prompting', async t => {
  const store = new ConfigStore(temporaryDirectory(t));
  let prompts = 0;
  const args = { email: 'person@qq.com', mailProvider: 'auto', calendarProvider: 'qq', calendarUser: 'person@qq.com', timezone: 'Asia/Shanghai', reuseMailSecret: true };
  await configInit(args, store, async () => { prompts++; return 'shared-synthetic-secret'; });
  assert.equal(prompts, 1);
  assert.equal(store.calendar().secret, store.mail().secret);
  await assert.rejects(configInit({ ...args, mailPort: 0, force: true }, store, async () => { prompts++; }), ConfigError);
  assert.equal(prompts, 1);
});

test('unsupported settings and credentials fields are rejected', t => {
  const value = settings();
  value.mail.legacy_credential = 'legacy';
  assert.throws(() => validateMailSettings(value), /Unsupported mail fields/);
  const store = new ConfigStore(temporaryDirectory(t));
  assert.throws(() => store.initialize(settings(), { ...credentials(), legacy: 'x' }), ConfigError);
  assert.throws(() => store.initialize({ ...settings(), calendar: { base_url: 'file:///tmp/calendar', auth: 'bearer' } }, credentials()), ConfigError);
});

test('POSIX permissions restrict directories and credentials', { skip: process.platform === 'win32' }, t => {
  const store = new ConfigStore(join(temporaryDirectory(t), 'private'));
  store.initialize(settings(), credentials());
  assert.equal(fs.statSync(store.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.credentialsPath).mode & 0o777, 0o600);
});

test('Windows ACL grants the current SID before disabling inheritance', () => {
  const calls = [];
  const run = (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: '"用户","S-1-5-21-123-456-789-1001"\n' }; };
  assert.equal(tightenWindowsAcl('test-directory', true, run), true);
  assert.equal(calls[0].command, 'whoami');
  assert.ok(calls[1].args.includes('*S-1-5-21-123-456-789-1001:(OI)(CI)F'));
  assert.equal(calls[2].args.at(-1), '/inheritance:r');
  assert.equal(calls[1].options.windowsHide, true);
  const failCalls = [];
  assert.equal(tightenWindowsAcl('test-directory', true, (command, args) => { failCalls.push(args); return { status: command === 'whoami' ? 0 : 1, stdout: 'S-1-5-21-1' }; }), false);
  assert.equal(failCalls.length, 2);
});

test('POSIX permission failures are reported', t => {
  assert.throws(() => makePrivate(join(temporaryDirectory(t), 'missing'), false, 'linux'), ConfigError);
});

test('mailbox identity is exactly compatible with Python uuid5', () => {
  const mail = settings().mail;
  assert.equal(mailboxKey(mail), '715bcf95-64bb-5855-bb73-0f81d63251c7');
  assert.equal(mailboxKey({ ...mail, host: mail.host.toUpperCase(), address: mail.address.toUpperCase() }), mailboxKey(mail));
});

test('state survives restarts, acknowledgements and retry, with atomic batch validation', t => {
  const path = join(temporaryDirectory(t), 'state.json');
  let state = new StateStore(path);
  state.recordDiscovered('mailbox-1', 'INBOX', '777', [{ uid: '10', subject: 'Meeting' }, { uid: '12' }], 12);
  state = new StateStore(path);
  assert.equal(state.cursor('mailbox-1', 'INBOX', '777'), 12);
  assert.deepEqual(state.pending('mailbox-1', 'INBOX', '777', 1).map(item => item.uid), ['10']);
  assert.throws(() => state.acknowledge('mailbox-1', 'INBOX', '777', [{ uid: '10' }, { uid: '999' }]), NotFoundError);
  assert.equal(state.pending('mailbox-1', 'INBOX', '777', 10).length, 2);
  state.acknowledge('mailbox-1', 'INBOX', '777', [{ uid: '10', outcome: 'created', event_uid: 'event-10' }]);
  assert.deepEqual({ ...state.summary('mailbox-1', 'INBOX').counts }, { processed: 1, pending: 1 });
  state.retry('mailbox-1', 'INBOX', '777', ['10']);
  assert.equal(new StateStore(path).pending('mailbox-1', 'INBOX', '777', 10).length, 2);
  assert.equal(fs.readdirSync(join(path, '..')).filter(name => name.endsWith('.tmp')).length, 0);
});

test('UIDVALIDITY or mailbox changes start a fresh generation', t => {
  const state = new StateStore(join(temporaryDirectory(t), 'state.json'));
  state.recordDiscovered('mailbox-1', 'INBOX', 'old', [{ uid: '10' }], 10);
  assert.equal(state.cursor('mailbox-1', 'INBOX', 'new'), 0);
  state.recordDiscovered('mailbox-1', 'INBOX', 'new', [{ uid: '1' }], 1);
  assert.deepEqual(state.pending('mailbox-1', 'INBOX', 'new', 10).map(item => item.uid), ['1']);
  assert.throws(() => state.currentUidvalidity('mailbox-2', 'INBOX'), ConfigError);
  assert.equal(state.cursor('mailbox-2', 'INBOX', 'new'), 0);
});

test('reads a Python version 1 state document without rewriting it', t => {
  const path = join(temporaryDirectory(t), 'state.json');
  const value = { version: 1, mailbox_key: '715bcf95-64bb-5855-bb73-0f81d63251c7', folders: { INBOX: {
    uidvalidity: '777', last_scanned_uid: 10, updated_at: '2026-09-11T10:00:00+00:00', messages: { '10': {
      message_id: '<m10@example.com>', status: 'pending', subject: 'Meeting', discovered_at: '2026-09-11T10:00:00+00:00', processed_at: '', outcome: '', event_uid: '',
    } },
  } } };
  fs.writeFileSync(path, JSON.stringify(value));
  const state = new StateStore(path);
  assert.equal(state.cursor(value.mailbox_key, 'INBOX', '777'), 10);
  assert.equal(state.pending(value.mailbox_key, 'INBOX', '777', 10)[0].message_id, '<m10@example.com>');
  assert.equal(fs.readFileSync(path, 'utf8'), JSON.stringify(value));
});
