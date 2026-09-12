import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { MINIMUM_NODE, NEXT_NODE_MAJOR, VERSION, buildParser, supportsNode } from '../src/cli.mjs';
import { createContext } from '../src/context.mjs';
import { ConfigStore } from '../src/config.mjs';
import { ConfigError } from '../src/errors.mjs';
import { settings, credentials, temporaryDirectory } from './support.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const leaves = command => command.commands.filter(child => child.name() !== 'help').map(child => child.name());
const node = (program, path) => path.split(' ').reduce(
  (current, name) => current.commands.find(child => child.name() === name),
  program,
);

// Drives a real parser over an injected context and returns the emitted payload.
const invoke = async (args, store) => {
  const program = buildParser(createContext({ storeFactory: () => store }));
  const written = [];
  const { write } = process.stdout;
  process.stdout.write = chunk => { written.push(String(chunk)); return true; };
  try { await program.parseAsync(args, { from: 'user' }); }
  finally { process.stdout.write = write; }
  return JSON.parse(written.join(''));
};

test('the supported Node range matches engines.node', () => {
  assert.equal(manifest.engines.node, `^${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}.0 || >=${NEXT_NODE_MAJOR}.0.0`);
  assert.ok(supportsNode(`${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}.0`));
  assert.ok(!supportsNode(`${MINIMUM_NODE.major}.${MINIMUM_NODE.minor - 1}.0`));
  assert.ok(supportsNode(`${NEXT_NODE_MAJOR}.0.0`));
  assert.ok(!supportsNode(`${NEXT_NODE_MAJOR - 1}.9.9`), `Node ${NEXT_NODE_MAJOR - 1} is excluded by engines.node`);
});

test('the parser exposes the documented command tree', () => {
  const program = buildParser();
  assert.ok(VERSION.length, 'VERSION must not be empty');
  assert.deepEqual(leaves(program), ['provider', 'config', 'mail', 'calendar']);
  assert.deepEqual(leaves(node(program, 'provider')), ['list', 'show']);
  assert.deepEqual(leaves(node(program, 'config')), ['init', 'show', 'test']);
  assert.deepEqual(leaves(node(program, 'mail')), ['folders', 'search', 'pending', 'get', 'ack', 'retry', 'state']);
  assert.deepEqual(leaves(node(program, 'calendar')), ['list', 'create', 'delete']);
  assert.deepEqual(node(program, 'provider show').registeredArguments.map(argument => argument.name()), ['kind', 'name']);
});

test('option defaults are kept', () => {
  const program = buildParser();
  // Defaults are part of the CLI contract and are easy to drop when a command is edited.
  assert.deepEqual(node(program, 'mail pending').opts(), { folder: 'INBOX', since: '30d', limit: 50, scanLimit: 200 });
  assert.deepEqual(node(program, 'mail search').opts(), { folder: 'INBOX', since: '30d', limit: 50 });
  assert.deepEqual(node(program, 'mail ack').opts(), { folder: 'INBOX', uid: [], outcome: 'processed' });
  assert.deepEqual(node(program, 'config init').opts(), { mailProvider: 'auto', timezone: 'Asia/Shanghai' });
});

test('building the parser does not read configuration', () => {
  let constructed = 0;
  const context = createContext({ storeFactory: () => { constructed++; throw new Error('configuration must stay lazy'); } });
  buildParser(context);
  assert.equal(constructed, 0);
});

test('a parse error surfaces as a commander error rather than exiting the process', async () => {
  // exitOverride and configureOutput have to be applied before the first .command():
  // a subcommand copies the exit callback by reference at construction, and one built
  // first calls process.exit() here, which would take the test runner down with it.
  await assert.rejects(buildParser().parseAsync(['mail', 'search', '--limit', '0'], { from: 'user' }), error => error.code === 'commander.invalidArgument');
  await assert.rejects(buildParser().parseAsync(['mail', 'pending', '--subject', 'x'], { from: 'user' }), error => error.code === 'commander.unknownOption');
});

test('the context reads the credentials file only when a secret is asked for', t => {
  const store = new ConfigStore(temporaryDirectory(t));
  store.initialize(settings(), credentials());
  rmSync(store.credentialsPath);
  const context = createContext({ storeFactory: () => store });
  // ack, retry and state deliberately take this path, so it must work unconfigured.
  assert.equal(context.mail(false).secret, undefined);
  assert.equal(context.mail(false).address, settings().mail.address);
  assert.throws(() => context.mail(), ConfigError);
  assert.throws(() => context.calendar(), ConfigError);
});

test('commands run end to end against an injected context', async t => {
  const store = new ConfigStore(temporaryDirectory(t));
  store.initialize(settings(), credentials());

  assert.deepEqual((await invoke(['provider', 'list'], store)).data, {
    mail: ['aliyun', 'gmail', 'netease-yeah', 'netease126', 'netease163', 'outlook', 'qq'],
    calendar: ['generic', 'google', 'qq'],
  });
  assert.equal((await invoke(['provider', 'show', 'mail', 'qq'], store)).data.host, 'imap.qq.com');

  const shown = await invoke(['config', 'show'], store);
  assert.equal(shown.data.settings.mail.host, settings().mail.host);
  assert.equal(shown.ok, true);
  assert.ok(!JSON.stringify(shown).includes('synthetic-mail-secret'));

  const state = await invoke(['mail', 'state'], store);
  assert.equal(state.data.folder, 'INBOX');
  assert.deepEqual({ ...state.data.counts }, {});
});
