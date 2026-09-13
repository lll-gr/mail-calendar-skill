import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from '../src/config.mjs';
import { temporaryDirectory, settings, credentials, davServer, imapServer } from './support.mjs';

const execute = promisify(execFile);
const skill = fileURLToPath(new URL('../skills/mail-calendar/', import.meta.url));

test('installed skill runs outside the repo with no node_modules, through real IMAP and CalDAV', { timeout: 60000 }, async t => {
  const root = temporaryDirectory(t);
  const installed = join(root, 'installed skill');
  cpSync(skill, installed, { recursive: true });
  const script = join(installed, 'scripts', 'mailcal.mjs');
  assert.equal(existsSync(join(root, 'node_modules')), false);
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  delete env.NODE_PATH;
  const invoke = (args, input = '') => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
  const json = async (args, input) => JSON.parse((await invoke(args, input)).stdout);
  assert.equal((await json(['provider', 'list'])).ok, true);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal((await invoke(['--version'])).stdout.trim(), version);
  assert.ok((await invoke(['mail', 'pending', '--help'])).stdout.includes('--scan-limit'));
  const imap = await imapServer(t);
  const dav = await davServer(t, { redirect: true });
  const value = settings();
  value.mail = { ...value.mail, host: imap.host, port: imap.port, security: 'plain' };
  value.calendar = { base_url: dav.base, collection_url: new URL('calendars/user/default/', dav.base).href, auth: 'basic', username: 'person' };
  const store = new ConfigStore(join(root, '.mail-calendar-skill'));
  store.initialize(value, credentials());
  const shown = await json(['config', 'show']);
  assert.equal(shown.data.settings.mail.port, imap.port);
  assert.ok(!JSON.stringify(shown).includes('synthetic-mail-secret'));
  assert.equal((await json(['config', 'test'])).data.caldav.calendars[0].name, 'Work & Meetings');
  const pending = await json(['mail', 'pending', '--since', '30d']);
  assert.equal(pending.data.discovered, 2);
  assert.deepEqual(pending.data.pending.map(item => item.uid), ['10', '12']);
  const message = await json(['mail', 'get', '--uid', '10']);
  assert.equal(message.data.subject, '会议通知');
  assert.ok(message.data.text.includes('Interview at 14:00'));
  assert.equal(message.data.attachments[0].filename, 'guide.pdf');
  const event = { source_id: '<test@example.com>#1', summary: 'Interview', start: '2026-09-15T14:00:00+08:00', alarms: ['-PT1H'] };
  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  const created = await json(['calendar', 'create', '--input', eventPath]);
  assert.equal(created.data.uid, '6d76f604-a314-54b2-8596-9e93c03ec984');
  const updated = await json(['calendar', 'create', '--input', '-'], JSON.stringify({ ...event, description: 'Updated' }));
  assert.equal(updated.data.http_status, 204);
  assert.equal(dav.events.size, 1);
  const occurrences = await json(['calendar', 'events', '--start', '2026-09-15', '--end', '2026-09-16']);
  assert.equal(occurrences.data.events[0].uid, created.data.uid);
  assert.equal(occurrences.data.events[0].description, 'Updated');
  const detail = await json(['calendar', 'get', '--uid', created.data.uid]);
  assert.equal(detail.data.events[0].start, '2026-09-15T06:00:00.000Z');
  assert.equal((await json(['calendar', 'get', '--url', created.data.url])).data.etag, '"v1"');
  await json(['mail', 'ack', '--uid', '10', '--outcome', 'created', '--event-uid', created.data.uid]);
  assert.deepEqual((await json(['mail', 'pending'])).data.pending.map(item => item.uid), ['12']);
  await json(['mail', 'retry', '--uid', '10']);
  await json(['mail', 'ack', '--input', '-'], JSON.stringify([{ uid: '10', outcome: 'ignored' }, { uid: '12', outcome: 'ignored' }]));
  assert.equal((await json(['mail', 'state'])).data.counts.processed, 2);
  assert.equal((await json(['mail', 'search', '--subject', 'Meeting'])).data.length, 2);
  assert.equal((await json(['mail', 'folders'])).data[0].name, 'INBOX');
  assert.equal((await json(['calendar', 'delete', '--uid', created.data.uid])).data.deleted, true);
  assert.equal(dav.events.size, 0);
  assert.ok(imap.commands.some(command => command.includes('EXAMINE')));
  assert.ok(imap.commands.some(command => command.includes('BODY.PEEK[]')));
  assert.ok(!imap.commands.some(command => /\b(?:SELECT|STORE|EXPUNGE)\b/.test(command)));
  const alias = join(root, 'skill alias');
  symlinkSync(installed, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(JSON.parse((await execute(process.execPath, [join(alias, 'scripts/mailcal.mjs'), 'provider', 'list'], { cwd: root, env })).stdout).ok, true);
});

test('CLI rejects unsupported filters and noninteractive credentials without exposing secrets', async t => {
  const root = temporaryDirectory(t);
  const script = fileURLToPath(new URL('../skills/mail-calendar/scripts/mailcal.mjs', import.meta.url));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  for (const args of [
    ['mail', 'pending', '--subject', 'Meeting'],
    ['mail', 'search', '--limit', '0'],
    ['config', 'init', '--email', 'person@qq.com', '--calendar-provider', 'qq', '--calendar-user', 'person@qq.com'],
  ]) {
    await assert.rejects(execute(process.execPath, [script, ...args], { cwd: root, env }), error => {
      const failure = JSON.parse(error.stderr);
      assert.equal(failure.ok, false);
      assert.equal(failure.error.code, 'INVALID_INPUT');
      assert.equal(error.stdout, '');
      return true;
    });
  }
});
