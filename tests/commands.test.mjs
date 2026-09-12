import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { MINIMUM_NODE, NEXT_NODE_MAJOR, VERSION, buildParser, supportsNode } from '../src/cli.mjs';
import { commands, groups } from '../src/commands.mjs';
import { createContext } from '../src/context.mjs';
import { ConfigStore } from '../src/config.mjs';
import { ConfigError } from '../src/errors.mjs';
import { settings, credentials, temporaryDirectory } from './support.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const node = (program, path) => path.split(' ').reduce(
  (current, name) => current.commands.find(child => child.name() === name),
  program,
);

test('the supported Node range matches engines.node', () => {
  assert.equal(manifest.engines.node, `^${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}.0 || >=${NEXT_NODE_MAJOR}.0.0`);
  assert.ok(supportsNode(`${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}.0`));
  assert.ok(!supportsNode(`${MINIMUM_NODE.major}.${MINIMUM_NODE.minor - 1}.0`));
  assert.ok(supportsNode(`${NEXT_NODE_MAJOR}.0.0`));
  assert.ok(!supportsNode(`${NEXT_NODE_MAJOR - 1}.9.9`), `Node ${NEXT_NODE_MAJOR - 1} is excluded by engines.node`);
});

test('the registry is well formed', () => {
  assert.ok(VERSION.length, 'VERSION must not be empty');
  const names = new Set();
  for (const command of commands) {
    const [group, leaf] = command.name.split(' ');
    assert.ok(!names.has(command.name), `duplicate command: ${command.name}`);
    names.add(command.name);
    assert.ok(leaf, `${command.name} must name a group and a leaf`);
    assert.ok(groups.some(entry => entry.name === group), `unknown group in: ${command.name}`);
    assert.ok(command.description, `${command.name} needs a description`);
    assert.equal(typeof command.run, 'function', `${command.name} needs a run function`);
  }
  for (const group of groups) {
    assert.ok(commands.some(command => command.name.startsWith(`${group.name} `)), `${group.name} has no commands`);
    assert.ok(group.description, `${group.name} needs a description`);
  }
});

test('the parser builds every command from the registry with its documented defaults', () => {
  const program = buildParser();
  assert.deepEqual(program.commands.filter(child => child.name() !== 'help').map(child => child.name()), groups.map(entry => entry.name));
  for (const command of commands) {
    assert.ok(node(program, command.name), `${command.name} is missing from the built parser`);
  }
  // Defaults are part of the CLI contract and the registry can silently lose one.
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

test('a command handler runs against an injected context and state file', async t => {
  const store = new ConfigStore(temporaryDirectory(t));
  store.initialize(settings(), credentials());
  const context = createContext({ storeFactory: () => store });
  const run = name => commands.find(command => command.name === name).run;

  assert.deepEqual(await run('provider list')(context, {}), { mail: ['aliyun', 'gmail', 'netease-yeah', 'netease126', 'netease163', 'outlook', 'qq'], calendar: ['generic', 'google', 'qq'] });
  assert.equal((await run('provider show')(context, {}, ['mail', 'qq'])).host, 'imap.qq.com');
  assert.throws(() => run('provider show')(context, {}, ['mail', 'nope']), /Unknown mail provider/);

  const shown = await run('config show')(context, {});
  assert.equal(shown.settings.mail.host, settings().mail.host);
  assert.ok(!JSON.stringify(shown).includes('synthetic-mail-secret'));

  const state = await run('mail state')(context, { folder: 'INBOX' });
  assert.equal(state.folder, 'INBOX');
  assert.deepEqual({ ...state.counts }, {});
});
