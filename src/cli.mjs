#!/usr/bin/env node
import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commands, groups, emit } from './commands.mjs';
import { createContext } from './context.mjs';
import { MailCalError, InputError } from './errors.mjs';
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

export function buildParser(ctx = createContext()) {
  const program = new Command()
    .name('mailcal')
    .description('Protocol-only CLI for one IMAP mailbox and one CalDAV calendar.')
    .version(VERSION);
  // Both calls must precede any .command(): a subcommand copies the exit callback and
  // output configuration by reference at construction time. A subcommand built first
  // would call process.exit() on a parse error and bypass the JSON error envelope.
  program.exitOverride().configureOutput({ outputError: () => {} });
  // Groups come from a table, and commander rejects a duplicate name, so build each
  // one once and hang the leaf commands off the cached node.
  const nodes = new Map();
  for (const group of groups) nodes.set(group.name, program.command(group.name).description(group.description));
  for (const command of commands) {
    const separator = command.name.indexOf(' ');
    const node = nodes
      .get(command.name.slice(0, separator))
      .command(command.name.slice(separator + 1))
      .description(command.description);
    for (const argument of command.arguments ?? []) node.addArgument(argument);
    for (const option of command.options ?? []) node.addOption(option);
    node.action(async (...values) => {
      // An action receives the declared positional arguments, then the options object.
      const declared = command.arguments?.length ?? 0;
      emit(await command.run(ctx, values[declared], values.slice(0, declared)));
    });
  }
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
