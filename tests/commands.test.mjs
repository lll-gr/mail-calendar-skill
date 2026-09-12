import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MINIMUM_NODE, NEXT_NODE_MAJOR, VERSION, supportsNode } from '../src/cli.mjs';
import { commands, groups } from '../src/commands.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
