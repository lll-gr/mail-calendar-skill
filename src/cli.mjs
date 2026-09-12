#!/usr/bin/env node
import { Command, Option, InvalidArgumentError } from 'commander';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { ConfigStore, configInit } from './config.mjs';
import { MAIL_PROVIDERS, CALENDAR_PROVIDERS } from './providers.mjs';
import { StateStore, mailboxKey } from './state.mjs';
import { imapFolders, imapSearch, imapPending, imapGet, withImap } from './imap.mjs';
import { calendarList, calendarCreate, calendarDelete } from './caldav.mjs';
import { MailCalError, InputError, NotFoundError, isObject } from './errors.mjs';

export const VERSION = manifest.version;
const emit = data => process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');

export function readInput(path, label, array = false) {
  let value;
  try { value = JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new InputError(`Cannot read ${label} JSON`); }
  if (array ? !Array.isArray(value) || !value.every(isObject) : !isObject(value)) {
    throw new InputError(array ? `${label} JSON must be an array of objects` : `${label} JSON must be an object`);
  }
  return value;
}

const positiveInteger = value => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new InvalidArgumentError('Must be a positive integer');
  return Number(value);
};
const repeat = (value, previous) => [...previous, value];
const folderOption = command => command.option('--folder <name>', 'IMAP folder', 'INBOX');
const limitOptions = command => folderOption(command).option('--since <date>', 'YYYY-MM-DD, Nd, or Nw', '30d').option('--limit <number>', 'Maximum headers returned', positiveInteger, 50);
const run = handler => async (...values) => emit(await handler(...values));

export function buildParser(storeFactory = () => new ConfigStore()) {
  const program = new Command().name('mailcal').description('Protocol-only CLI for one IMAP mailbox and one CalDAV calendar.').version(VERSION);
  program.exitOverride().configureOutput({ outputError: () => {} });
  const provider = program.command('provider').description('Inspect provider presets');
  provider.command('list').action(run(() => ({ mail: Object.keys(MAIL_PROVIDERS).sort(), calendar: Object.keys(CALENDAR_PROVIDERS).sort() })));
  provider.command('show').argument('<kind>', 'mail or calendar').argument('<name>').action(run((kind, name) => {
    if (!['mail', 'calendar'].includes(kind)) throw new InputError('Provider kind must be mail or calendar');
    const source = kind === 'mail' ? MAIL_PROVIDERS : CALENDAR_PROVIDERS;
    if (!Object.hasOwn(source, name)) throw new NotFoundError(`Unknown ${kind} provider: ${name}`);
    return { kind, name, ...source[name] };
  }));
  const config = program.command('config').description('Configure the mailbox and calendar');
  config.command('init').requiredOption('--email <address>')
    .option('--mail-provider <name>', 'Mail provider', 'auto').option('--mail-host <host>')
    .option('--mail-port <port>', 'IMAP port', positiveInteger)
    .addOption(new Option('--mail-security <mode>').choices(['ssl', 'starttls', 'plain']))
    .addOption(new Option('--mail-auth <mode>').choices(['password', 'xoauth2']))
    .addOption(new Option('--calendar-provider <name>').choices(Object.keys(CALENDAR_PROVIDERS)).makeOptionMandatory())
    .option('--calendar-url <url>').option('--calendar-collection-url <url>').option('--calendar-user <name>')
    .addOption(new Option('--calendar-auth <mode>').choices(['basic', 'bearer']))
    .option('--reuse-mail-secret', 'Use mail credentials for the calendar too')
    .option('--timezone <name>', 'Default timezone', 'Asia/Shanghai').option('--force', 'Replace existing configuration')
    .action(run(args => configInit(args, storeFactory())));
  config.command('show').action(run(() => storeFactory().show()));
  config.command('test').action(run(async () => {
    const store = storeFactory();
    const settings = store.mail();
    await withImap(settings, async () => {});
    return { imap: { ok: true, server: `${settings.host}:${settings.port}` }, caldav: { ok: true, calendars: await calendarList(store.calendar()) } };
  }));
  const mail = program.command('mail').description('Read mail and manage processing state');
  mail.command('folders').action(run(() => imapFolders(storeFactory().mail())));
  limitOptions(mail.command('search')).option('--subject <text>').option('--from <text>').option('--unseen')
    .action(run(args => imapSearch(storeFactory().mail(), args)));
  limitOptions(mail.command('pending')).option('--scan-limit <number>', 'Maximum new headers fetched', positiveInteger, 200)
    .action(run(args => { const store = storeFactory(); return imapPending(store.mail(), args, store.statePath); }));
  folderOption(mail.command('get')).requiredOption('--uid <uid>')
    .action(run(args => imapGet(storeFactory().mail(), args.folder, args.uid)));
  folderOption(mail.command('ack')).option('--uid <uid>', 'Repeat for multiple messages', repeat, [])
    .addOption(new Option('--input <path>', 'JSON array path, or - for stdin').conflicts('uid'))
    .option('--outcome <value>', 'Processing outcome', 'processed').option('--event-uid <uid>')
    .action(run(args => {
      const store = storeFactory();
      const state = new StateStore(store.statePath);
      const key = mailboxKey(store.mail(false));
      const validity = state.currentUidvalidity(key, args.folder);
      if (!args.input && !args.uid.length) throw new InputError('mail ack requires --uid or --input');
      const items = args.input ? readInput(args.input, 'Acknowledgement', true) : args.uid.map(uid => ({ uid, outcome: args.outcome, event_uid: args.eventUid ?? '' }));
      return { folder: args.folder, uidvalidity: validity, acknowledged: state.acknowledge(key, args.folder, validity, items) };
    }));
  folderOption(mail.command('retry')).requiredOption('--uid <uid>', 'Repeat for multiple messages', repeat, [])
    .action(run(args => {
      const store = storeFactory();
      const state = new StateStore(store.statePath);
      const key = mailboxKey(store.mail(false));
      const validity = state.currentUidvalidity(key, args.folder);
      return { folder: args.folder, uidvalidity: validity, retried: state.retry(key, args.folder, validity, args.uid) };
    }));
  folderOption(mail.command('state')).action(run(args => {
    const store = storeFactory();
    return new StateStore(store.statePath).summary(mailboxKey(store.mail(false)), args.folder);
  }));
  const calendar = program.command('calendar').description('Manage CalDAV calendar events');
  calendar.command('list').action(run(() => calendarList(storeFactory().calendar())));
  calendar.command('create').requiredOption('--input <path>', 'Event JSON path, or - for stdin').option('--calendar-url <url>')
    .action(run(args => calendarCreate(storeFactory().calendar(), readInput(args.input, 'Event'), args.calendarUrl)));
  calendar.command('delete').option('--uid <uid>').option('--url <url>').option('--calendar-url <url>')
    .action(run(args => calendarDelete(storeFactory().calendar(), args.uid, args.url, args.calendarUrl)));
  return program;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major === 22 && minor >= 13 || major >= 24)) throw new InputError('Node.js 22.13+ or 24+ is required');
    await buildParser().parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error.code?.startsWith('commander.') && error.exitCode === 0) return 0;
    const failure = error instanceof MailCalError ? error : error.code?.startsWith('commander.') ? new InputError(error.message) : new MailCalError('Unexpected error; check the configuration and input');
    process.stderr.write(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }, null, 2) + '\n');
    return failure.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.once('SIGINT', () => {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'INTERRUPTED', message: 'Operation interrupted' } }) + '\n');
    process.exit(130);
  });
  process.exitCode = await main();
}
