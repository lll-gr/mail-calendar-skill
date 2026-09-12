import { readFileSync } from 'node:fs';
import { Argument, InvalidArgumentError, Option } from 'commander';
import { configInit } from './config.mjs';
import { MAIL_PROVIDERS, CALENDAR_PROVIDERS } from './providers.mjs';
import { imapFolders, imapSearch, imapPending, imapGet, withImap } from './imap.mjs';
import { calendarList, calendarCreate, calendarDelete } from './caldav.mjs';
import { InputError, NotFoundError, isObject, positiveInteger } from './errors.mjs';

export const emit = data => process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');

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

// Commander keeps Option instances by reference, so every command gets its own
// instance: a shared one would let one command's chaining silently redefine the
// flag for every other command that declares it.
const folderOption = () => new Option('--folder <name>', 'IMAP folder').default('INBOX');
const sinceOption = () => new Option('--since <date>', 'YYYY-MM-DD, Nd, or Nw').default('30d');
const limitOption = () => new Option('--limit <number>', 'Maximum headers returned').default(50).argParser(positiveCount);
const repeatableUid = () => new Option('--uid <uid>', 'Repeat for multiple messages')
  .argParser((value, previous) => [...previous, value]).default([]);

export const groups = [
  { name: 'provider', description: 'Inspect provider presets' },
  { name: 'config', description: 'Configure the mailbox and calendar' },
  { name: 'mail', description: 'Read mail and manage processing state' },
  { name: 'calendar', description: 'Manage CalDAV calendar events' },
];

// Each entry is one command: `run` receives the shared context, the parsed options
// and any declared positional arguments, and returns the JSON `data` payload.
export const commands = [
  {
    name: 'provider list',
    description: 'List the mail and calendar provider presets',
    run: () => ({ mail: Object.keys(MAIL_PROVIDERS).sort(), calendar: Object.keys(CALENDAR_PROVIDERS).sort() }),
  },
  {
    name: 'provider show',
    description: 'Show one provider preset',
    arguments: [new Argument('<kind>', 'mail or calendar'), new Argument('<name>')],
    run: (ctx, args, [kind, name]) => {
      if (!['mail', 'calendar'].includes(kind)) throw new InputError('Provider kind must be mail or calendar');
      const source = kind === 'mail' ? MAIL_PROVIDERS : CALENDAR_PROVIDERS;
      if (!Object.hasOwn(source, name)) throw new NotFoundError(`Unknown ${kind} provider: ${name}`);
      return { kind, name, ...source[name] };
    },
  },
  {
    name: 'config init',
    description: 'Write settings and credentials for one mailbox and one calendar',
    options: [
      new Option('--email <address>').makeOptionMandatory(),
      new Option('--mail-provider <name>', 'Mail provider').default('auto'),
      new Option('--mail-host <host>'),
      new Option('--mail-port <port>', 'IMAP port').argParser(positiveCount),
      new Option('--mail-security <mode>').choices(['ssl', 'starttls', 'plain']),
      new Option('--mail-auth <mode>').choices(['password', 'xoauth2']),
      new Option('--calendar-provider <name>').choices(Object.keys(CALENDAR_PROVIDERS)).makeOptionMandatory(),
      new Option('--calendar-url <url>'),
      new Option('--calendar-collection-url <url>'),
      new Option('--calendar-user <name>'),
      new Option('--calendar-auth <mode>').choices(['basic', 'bearer']),
      new Option('--reuse-mail-secret', 'Use mail credentials for the calendar too'),
      new Option('--timezone <name>', 'Default timezone').default('Asia/Shanghai'),
      new Option('--force', 'Replace existing configuration'),
    ],
    run: (ctx, args) => configInit(args, ctx.config()),
  },
  {
    name: 'config show',
    description: 'Show the config paths and non-sensitive settings',
    run: ctx => ctx.config().show(),
  },
  {
    name: 'config test',
    description: 'Connect to the mailbox and discover calendars',
    run: async ctx => {
      const settings = ctx.mail();
      await withImap(settings, async () => {});
      return { imap: { ok: true, server: `${settings.host}:${settings.port}` }, caldav: { ok: true, calendars: await calendarList(ctx.calendar()) } };
    },
  },
  {
    name: 'mail folders',
    description: 'List the folders in the mailbox',
    run: ctx => imapFolders(ctx.mail()),
  },
  {
    name: 'mail search',
    description: 'Search message headers without touching the processing state',
    options: [folderOption(), sinceOption(), limitOption(), new Option('--subject <text>'), new Option('--from <text>'), new Option('--unseen')],
    run: (ctx, args) => imapSearch(ctx.mail(), args),
  },
  {
    name: 'mail pending',
    description: 'Download new headers and return the queue awaiting acknowledgement',
    options: [folderOption(), sinceOption(), limitOption(), new Option('--scan-limit <number>', 'Maximum new headers fetched').default(200).argParser(positiveCount)],
    run: (ctx, args) => imapPending(ctx.mail(), args, ctx.statePath()),
  },
  {
    name: 'mail get',
    description: 'Return one message with its text body and attachment metadata',
    options: [folderOption(), new Option('--uid <uid>').makeOptionMandatory()],
    run: (ctx, args) => imapGet(ctx.mail(), args.folder, args.uid),
  },
  {
    name: 'mail ack',
    description: 'Mark discovered messages as processed',
    options: [
      folderOption(),
      repeatableUid(),
      new Option('--input <path>', 'JSON array path, or - for stdin').conflicts('uid'),
      new Option('--outcome <value>', 'Processing outcome').default('processed'),
      new Option('--event-uid <uid>'),
    ],
    run: (ctx, args) => {
      const box = ctx.mailbox(args.folder);
      if (!args.input && !args.uid.length) throw new InputError('mail ack requires --uid or --input');
      const items = args.input ? readInput(args.input, 'Acknowledgement', true) : args.uid.map(uid => ({ uid, outcome: args.outcome, event_uid: args.eventUid ?? '' }));
      return { folder: args.folder, uidvalidity: box.validity, acknowledged: ctx.state().acknowledge(box.key, args.folder, box.validity, items) };
    },
  },
  {
    name: 'mail retry',
    description: 'Return processed messages to the pending queue',
    options: [folderOption(), repeatableUid()],
    run: (ctx, args) => {
      if (!args.uid.length) throw new InputError('mail retry requires --uid');
      const box = ctx.mailbox(args.folder);
      return { folder: args.folder, uidvalidity: box.validity, retried: ctx.state().retry(box.key, args.folder, box.validity, args.uid) };
    },
  },
  {
    name: 'mail state',
    description: 'Show the cursor and message counts for one folder',
    options: [folderOption()],
    run: (ctx, args) => ctx.state().summary(ctx.mailKey(), args.folder),
  },
  {
    name: 'calendar list',
    description: 'List the calendars visible to the account',
    run: ctx => calendarList(ctx.calendar()),
  },
  {
    name: 'calendar create',
    description: 'Create an event, replacing any event with the same UID',
    options: [new Option('--input <path>', 'Event JSON path, or - for stdin').makeOptionMandatory(), new Option('--calendar-url <url>')],
    run: (ctx, args) => calendarCreate(ctx.calendar(), readInput(args.input, 'Event'), args.calendarUrl),
  },
  {
    name: 'calendar delete',
    description: 'Delete an event by UID or resource URL',
    options: [new Option('--uid <uid>'), new Option('--url <url>'), new Option('--calendar-url <url>')],
    run: (ctx, args) => calendarDelete(ctx.calendar(), args.uid, args.url, args.calendarUrl),
  },
];
