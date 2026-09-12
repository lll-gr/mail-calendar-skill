#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configInit } from './config.mjs';
import { createContext } from './context.mjs';
import { MAIL_PROVIDERS, CALENDAR_PROVIDERS } from './providers.mjs';
import { imapFolders, imapSearch, imapPending, imapGet, withImap } from './imap.mjs';
import { calendarList, calendarCreate, calendarDelete } from './caldav.mjs';
import { MailCalError, InputError, NotFoundError, isObject, positiveInteger } from './errors.mjs';
import { VERSION } from './version.mjs';

// Mirrors `engines.node` in package.json (`^22.13.0 || >=24.0.0`, which excludes
// Node 23). A test asserts the two agree, so this is the only place to change it.
export const MINIMUM_NODE = { major: 22, minor: 13 };
export const NEXT_NODE_MAJOR = 24;

export const supportsNode = version => {
  const [major, minor] = String(version).split('.').map(Number);
  return (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor) || major >= NEXT_NODE_MAJOR;
};

export { VERSION };

const emit = data => process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');
const run = handler => async (...values) => emit(await handler(...values));

export function readInput(path, label, array = false) {
  let value;
  try { value = JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8')); }
  catch { throw new InputError(`Cannot read ${label} JSON`); }
  if (array ? !Array.isArray(value) || !value.every(isObject) : !isObject(value)) {
    throw new InputError(array ? `${label} JSON must be an array of objects` : `${label} JSON must be an object`);
  }
  return value;
}

const positiveCount = value => {
  const parsed = positiveInteger(value);
  if (parsed === undefined) throw new InvalidArgumentError('Must be a positive integer');
  return parsed;
};

// Each command builds its own Option instance. Commander keeps the instance by
// reference, so a shared one would let one command's chaining redefine the flag for
// every other command that declares it.
const folderOption = () => new Option('--folder <name>', 'IMAP folder').default('INBOX');
const sinceOption = () => new Option('--since <date>', 'YYYY-MM-DD, Nd, or Nw').default('30d');
const limitOption = () => new Option('--limit <number>', 'Maximum headers returned').default(50).argParser(positiveCount);
const uidOption = () => new Option('--uid <uid>', 'Repeat for multiple messages')
  .argParser((value, previous) => [...previous, value]).default([]);

export function buildParser(ctx = createContext()) {
  const program = new Command()
    .name('mailcal')
    .description('Protocol-only CLI for one IMAP mailbox and one CalDAV calendar.')
    .version(VERSION);
  // Both calls must precede any .command(): a subcommand copies the exit callback and
  // output configuration by reference at construction time. A subcommand built first
  // calls process.exit() on a parse error and bypasses the JSON error envelope.
  program.exitOverride().configureOutput({ outputError: () => {} });

  const provider = program.command('provider').description('Inspect provider presets');
  provider.command('list').description('List the mail and calendar provider presets')
    .action(run(() => ({ mail: Object.keys(MAIL_PROVIDERS).sort(), calendar: Object.keys(CALENDAR_PROVIDERS).sort() })));
  provider.command('show').description('Show one provider preset').argument('<kind>', 'mail or calendar').argument('<name>')
    .action(run((kind, name) => {
      if (!['mail', 'calendar'].includes(kind)) throw new InputError('Provider kind must be mail or calendar');
      const source = kind === 'mail' ? MAIL_PROVIDERS : CALENDAR_PROVIDERS;
      if (!Object.hasOwn(source, name)) throw new NotFoundError(`Unknown ${kind} provider: ${name}`);
      return { kind, name, ...source[name] };
    }));

  const config = program.command('config').description('Configure the mailbox and calendar');
  config.command('init').description('Write settings and credentials for one mailbox and one calendar')
    .addOption(new Option('--email <address>').makeOptionMandatory())
    .addOption(new Option('--mail-provider <name>', 'Mail provider').default('auto'))
    .addOption(new Option('--mail-host <host>'))
    .addOption(new Option('--mail-port <port>', 'IMAP port').argParser(positiveCount))
    .addOption(new Option('--mail-security <mode>').choices(['ssl', 'starttls', 'plain']))
    .addOption(new Option('--mail-auth <mode>').choices(['password', 'xoauth2']))
    .addOption(new Option('--calendar-provider <name>').choices(Object.keys(CALENDAR_PROVIDERS)).makeOptionMandatory())
    .addOption(new Option('--calendar-url <url>'))
    .addOption(new Option('--calendar-collection-url <url>'))
    .addOption(new Option('--calendar-user <name>'))
    .addOption(new Option('--calendar-auth <mode>').choices(['basic', 'bearer']))
    .addOption(new Option('--reuse-mail-secret', 'Use mail credentials for the calendar too'))
    .addOption(new Option('--timezone <name>', 'Default timezone').default('Asia/Shanghai'))
    .addOption(new Option('--force', 'Replace existing configuration'))
    .action(run(args => configInit(args, ctx.config())));
  config.command('show').description('Show the config paths and non-sensitive settings')
    .action(run(() => ctx.config().show()));
  config.command('test').description('Connect to the mailbox and discover calendars')
    .action(run(async () => {
      const settings = ctx.mail();
      await withImap(settings, async () => {});
      return { imap: { ok: true, server: `${settings.host}:${settings.port}` }, caldav: { ok: true, calendars: await calendarList(ctx.calendar()) } };
    }));

  const mail = program.command('mail').description('Read mail and manage processing state');
  mail.command('folders').description('List the folders in the mailbox')
    .action(run(() => imapFolders(ctx.mail())));
  mail.command('search').description('Search message headers without touching the processing state')
    .addOption(folderOption()).addOption(sinceOption()).addOption(limitOption())
    .option('--subject <text>').option('--from <text>').option('--unseen')
    .action(run(args => imapSearch(ctx.mail(), args)));
  mail.command('pending').description('Download new headers and return the queue awaiting acknowledgement')
    .addOption(folderOption()).addOption(sinceOption()).addOption(limitOption())
    .addOption(new Option('--scan-limit <number>', 'Maximum new headers fetched').default(200).argParser(positiveCount))
    .action(run(args => imapPending(ctx.mail(), args, ctx.statePath())));
  mail.command('get').description('Return one message with its text body and attachment metadata')
    .addOption(folderOption()).addOption(new Option('--uid <uid>').makeOptionMandatory())
    .action(run(args => imapGet(ctx.mail(), args.folder, args.uid)));
  mail.command('ack').description('Mark discovered messages as processed')
    .addOption(folderOption()).addOption(uidOption())
    .addOption(new Option('--input <path>', 'JSON array path, or - for stdin').conflicts('uid'))
    .addOption(new Option('--outcome <value>', 'Processing outcome').default('processed'))
    .addOption(new Option('--event-uid <uid>'))
    .action(run(args => {
      const box = ctx.mailbox(args.folder);
      if (!args.input && !args.uid.length) throw new InputError('mail ack requires --uid or --input');
      const items = args.input ? readInput(args.input, 'Acknowledgement', true) : args.uid.map(uid => ({ uid, outcome: args.outcome, event_uid: args.eventUid ?? '' }));
      return { folder: args.folder, uidvalidity: box.validity, acknowledged: ctx.state().acknowledge(box.key, args.folder, box.validity, items) };
    }));
  mail.command('retry').description('Return processed messages to the pending queue')
    .addOption(folderOption()).addOption(uidOption())
    .action(run(args => {
      if (!args.uid.length) throw new InputError('mail retry requires --uid');
      const box = ctx.mailbox(args.folder);
      return { folder: args.folder, uidvalidity: box.validity, retried: ctx.state().retry(box.key, args.folder, box.validity, args.uid) };
    }));
  mail.command('state').description('Show the cursor and message counts for one folder')
    .addOption(folderOption())
    .action(run(args => ctx.state().summary(ctx.mailKey(), args.folder)));

  const calendar = program.command('calendar').description('Manage CalDAV calendar events');
  calendar.command('list').description('List the calendars visible to the account')
    .action(run(() => calendarList(ctx.calendar())));
  calendar.command('create').description('Create an event, replacing any event with the same UID')
    .addOption(new Option('--input <path>', 'Event JSON path, or - for stdin').makeOptionMandatory())
    .addOption(new Option('--calendar-url <url>'))
    .action(run(args => calendarCreate(ctx.calendar(), readInput(args.input, 'Event'), args.calendarUrl)));
  calendar.command('delete').description('Delete an event by UID or resource URL')
    .addOption(new Option('--uid <uid>')).addOption(new Option('--url <url>')).addOption(new Option('--calendar-url <url>'))
    .action(run(args => calendarDelete(ctx.calendar(), args.uid, args.url, args.calendarUrl)));

  return program;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (!supportsNode(process.versions.node)) {
      throw new InputError(`Node.js ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}+ or ${NEXT_NODE_MAJOR}+ is required`);
    }
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
