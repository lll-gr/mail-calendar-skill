import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ConfigError, isObject } from './errors.mjs';

export function tightenWindowsAcl(path, directory, run = spawnSync) {
  const options = { windowsHide: true, stdio: 'ignore' };
  if (!directory) return run('icacls', [path, '/inheritance:e'], options).status === 0;
  // A SID avoids dependence on the Windows console code page for non-ASCII names.
  const identity = run('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
  const sid = identity.status === 0 && identity.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) return false;
  const grants = [`*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'];
  if (run('icacls', [path, '/grant:r', ...grants], options).status !== 0) return false;
  return run('icacls', [path, '/inheritance:r'], options).status === 0;
}

export function makePrivate(path, directory = false, platform = process.platform) {
  if (platform === 'win32') { tightenWindowsAcl(path, directory); return; }
  try { fs.chmodSync(path, directory ? 0o700 : 0o600); }
  catch { throw new ConfigError(`Cannot set private permissions on ${path}`); }
}

export function readJson(path, label) {
  if (!fs.existsSync(path)) throw new ConfigError(`${label} not found: ${path}. Run 'config init' first.`);
  let value;
  try { value = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { throw new ConfigError(`Cannot read valid ${label.toLowerCase()} JSON: ${path}`); }
  if (!isObject(value)) throw new ConfigError(`${label} root must be a JSON object`);
  return value;
}

export function writeJson(path, value, privateFile = false) {
  const directory = dirname(path);
  fs.mkdirSync(directory, { recursive: true });
  makePrivate(directory, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (privateFile) makePrivate(temporary);
    fs.renameSync(temporary, path);
    if (privateFile) makePrivate(path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Cannot save JSON file: ${path}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
