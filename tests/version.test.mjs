import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { temporaryDirectory } from './support.mjs';
import { validateVersion, withSkillVersion, skillVersion, checkVersionState, prepareVersion, syncSkillVersion, readVersionState } from '../tools/version.mjs';

const skill = '---\nname: mail-calendar\ndescription: Test\nmetadata:\n  author: test\n  version: "0.3.0"\nlicense: MIT\n---\n\nBody stays intact.\n';
const state = () => ({ manifest: { version: '0.3.0' }, lock: { version: '0.3.0', packages: { '': { version: '0.3.0' } } }, skill });

test('release versions accept SemVer and reject invalid or unsafe tag values', () => {
  for (const version of ['0.3.0', '1.2.3-rc.1', '1.2.3+build.42', '1.2.3-0']) assert.equal(validateVersion(version), version);
  for (const version of ['v0.3.0', '01.2.3', '1.2', '1.2.3-01', '../1.2.3', '1.2.3\n', '1.2.3-']) assert.throws(() => validateVersion(version));
});

test('Skill version synchronization preserves instructions and other YAML metadata', () => {
  const updated = withSkillVersion(skill.replaceAll('\n', '\r\n'), '0.4.0');
  assert.equal(skillVersion(updated), '0.4.0');
  assert.ok(updated.includes('  author: test\n') && updated.includes('license: MIT\n'));
  assert.ok(updated.endsWith('\n\nBody stays intact.\n'));
  assert.equal(withSkillVersion(updated, '0.4.0'), updated);
  assert.equal(skillVersion(withSkillVersion('---\nname: test\ndescription: Test\n---\nBody\n', '0.4.0')), '0.4.0');
});

test('tag, lockfile and Skill versions must all match the project', () => {
  assert.equal(checkVersionState(state(), 'v0.3.0'), '0.3.0');
  assert.throws(() => checkVersionState(state(), 'v0.4.0'), /Tag/);
  assert.throws(() => checkVersionState(state(), '0.3.0'), /Tag/);
  const locked = state(); locked.lock.packages[''].version = '0.2.0';
  assert.throws(() => checkVersionState(locked), /package-lock/);
  const drifted = state(); drifted.skill = withSkillVersion(skill, '0.2.0');
  assert.throws(() => checkVersionState(drifted), /metadata.version/);
  assert.equal(checkVersionState(drifted, 'v0.3.0', { includeSkill: false }), '0.3.0');
  assert.throws(() => checkVersionState(drifted, 'v0.4.0', { includeSkill: false }), /Tag/);
});

test('release preparation updates every version while retaining dependency resolutions', async t => {
  const root = temporaryDirectory(t);
  mkdirSync(join(root, 'skills/mail-calendar'), { recursive: true });
  const input = state();
  input.manifest.devDependencies = { library: '1.0.0' };
  input.lock.packages['node_modules/library'] = { version: '1.0.0', integrity: 'synthetic-fixed-integrity' };
  writeFileSync(join(root, 'package.json'), JSON.stringify(input.manifest));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(input.lock));
  writeFileSync(join(root, 'skills/mail-calendar/SKILL.md'), skill);
  await prepareVersion('0.4.0-rc.1', root);
  const result = await readVersionState(root);
  assert.equal(checkVersionState(result, 'v0.4.0-rc.1'), '0.4.0-rc.1');
  assert.deepEqual(result.lock.packages['node_modules/library'], input.lock.packages['node_modules/library']);
  assert.deepEqual(result.manifest.devDependencies, input.manifest.devDependencies);
  writeFileSync(join(root, 'skills/mail-calendar/SKILL.md'), skill);
  await syncSkillVersion(root);
  assert.equal(skillVersion(readFileSync(join(root, 'skills/mail-calendar/SKILL.md'), 'utf8')), '0.4.0-rc.1');
  const before = readFileSync(join(root, 'package.json'), 'utf8');
  await assert.rejects(prepareVersion('v0.4.0', root));
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before);
});

test('release preparation CLI finishes its build and rejects a mismatched tag', async t => {
  const root = temporaryDirectory(t);
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(join(root, 'skills/mail-calendar'), { recursive: true });
  const input = state();
  writeFileSync(join(root, 'package.json'), JSON.stringify(input.manifest));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(input.lock));
  writeFileSync(join(root, 'skills/mail-calendar/SKILL.md'), skill);
  copyFileSync(new URL('../tools/version.mjs', import.meta.url), join(root, 'tools/version.mjs'));
  // The builder imports the shared version helpers, just like the real builder.
  writeFileSync(join(root, 'tools/build.mjs'), "import { readVersionState, checkVersionState } from './version.mjs'; console.log('Built v' + checkVersionState(await readVersionState()));\n");
  const execute = promisify(execFile);
  symlinkSync(join(root, 'tools'), join(root, 'tool-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const executable = join(root, 'tool-alias/version.mjs');
  const result = await execute(process.execPath, [executable, '0.4.0'], { timeout: 5000 });
  assert.ok(result.stdout.includes('Built v0.4.0') && result.stdout.includes('Prepared v0.4.0'));
  await assert.rejects(execute(process.execPath, [executable, '--check', '--tag', 'v0.3.0'], { timeout: 5000 }), error => error.code === 1 && error.stderr.includes('Tag v0.3.0'));
  writeFileSync(join(root, 'tools/build.mjs'), "throw new Error('This local build must not run');\n");
  const prepared = await execute(process.execPath, [executable, '0.5.0', '--no-build'], { timeout: 5000 });
  assert.ok(prepared.stdout.includes('Prepared v0.5.0'));
  writeFileSync(join(root, 'skills/mail-calendar/SKILL.md'), skill);
  const checked = await execute(process.execPath, [executable, '--check', '--source', '--tag', 'v0.5.0'], { timeout: 5000 });
  assert.ok(checked.stdout.includes('Versions match: v0.5.0'));
  await assert.rejects(execute(process.execPath, [executable, '--check'], { timeout: 5000 }), error => error.code === 1 && error.stderr.includes('metadata.version'));
});
