import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const number = '(?:0|[1-9]\\d*)';
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function validateVersion(version) {
  if (typeof version !== 'string' || !semver.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  return version;
}

function frontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content.replaceAll('\r\n', '\n'));
  if (!match) throw new Error('Skill has no YAML frontmatter');
  return match;
}

function metadataBlock(header) {
  return /^metadata: *\n(?:[ \t]+[^\n]*(?:\n|$))*/m.exec(header + '\n');
}

export function skillVersion(content) {
  const block = metadataBlock(frontmatter(content)[1]);
  const value = block && /^  version: *["']?([^\s"']+)["']? *$/m.exec(block[0]);
  return value?.[1];
}

export function withSkillVersion(content, version) {
  validateVersion(version);
  content = content.replaceAll('\r\n', '\n');
  const match = frontmatter(content);
  const header = match[1];
  const block = metadataBlock(header);
  const field = `  version: "${version}"`;
  let updated;
  if (!block) updated = header + `\nmetadata:\n${field}`;
  else {
    const replacement = /^  version:.*$/m.test(block[0])
      ? block[0].replace(/^  version:.*$/m, field)
      : block[0].replace(/^metadata: *\n/, `metadata:\n${field}\n`);
    updated = (header + '\n').replace(block[0], replacement).replace(/\n$/, '');
  }
  return content.replace(match[0], `---\n${updated}\n---\n`);
}

export async function readVersionState(directory = root) {
  const [manifest, lock, skill] = await Promise.all([
    readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(directory, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(resolve(directory, 'skills/mail-calendar/SKILL.md'), 'utf8'),
  ]);
  return { manifest, lock, skill };
}

export function checkVersionState({ manifest, lock, skill }, tag, { includeSkill = true } = {}) {
  const version = validateVersion(manifest.version);
  if (lock.version !== version || lock.packages?.['']?.version !== version) throw new Error('package-lock.json version does not match package.json');
  if (includeSkill && skillVersion(skill) !== version) throw new Error('Skill metadata.version does not match package.json; run npm run build');
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match project and Skill version v${version}`);
  return version;
}

export async function syncSkillVersion(directory = root) {
  const state = await readVersionState(directory);
  const version = validateVersion(state.manifest.version);
  checkVersionState({ ...state, skill: withSkillVersion(state.skill, version) });
  const updated = withSkillVersion(state.skill, version);
  if (updated !== state.skill) await writeFile(resolve(directory, 'skills/mail-calendar/SKILL.md'), updated);
  return version;
}

export async function prepareVersion(version, directory = root) {
  validateVersion(version);
  const state = await readVersionState(directory);
  state.manifest.version = version;
  state.lock.version = version;
  if (!state.lock.packages?.['']) throw new Error('package-lock.json has no root package');
  state.lock.packages[''].version = version;
  const updatedSkill = withSkillVersion(state.skill, version);
  // Only version fields change; dependency resolutions and other metadata stay intact.
  await writeFile(resolve(directory, 'package.json'), JSON.stringify(state.manifest, null, 2) + '\n');
  await writeFile(resolve(directory, 'package-lock.json'), JSON.stringify(state.lock, null, 2) + '\n');
  await writeFile(resolve(directory, 'skills/mail-calendar/SKILL.md'), updatedSkill);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--check') {
      const flags = args.slice(1);
      const source = flags.includes('--source');
      if (source) flags.splice(flags.indexOf('--source'), 1);
      if (flags.length && !(flags.length === 2 && flags[0] === '--tag')) throw new Error('Invalid version check arguments');
      console.log(`Versions match: v${checkVersionState(await readVersionState(), flags[1], { includeSkill: !source })}`);
    } else if (args.length === 1 || (args.length === 2 && args[1] === '--no-build')) {
      await prepareVersion(args[0]);
      if (args[1] !== '--no-build') {
        const built = spawnSync(process.execPath, [resolve(root, 'tools/build.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
        if (built.error || built.status !== 0) throw new Error('Version updated, but build failed; fix the build before tagging');
      }
      console.log(`Prepared v${args[0]}. Commit the changed files before creating the tag.`);
    } else throw new Error('Usage: node tools/version.mjs <version> [--no-build] | --check [--source] [--tag <tag>]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
