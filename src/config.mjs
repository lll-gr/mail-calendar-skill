import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import password from '@inquirer/password';
import { ConfigError, InputError, MailCalError, isObject } from './errors.mjs';
import { MAIL_PROVIDERS, CALENDAR_PROVIDERS, detectMailProvider } from './providers.mjs';
import { readJson, writeJson } from './storage.mjs';

export const storageDirectory = () => join(homedir(), '.mail-calendar-skill');

function allowedFields(value, allowed, label) {
  if (!isObject(value)) throw new ConfigError(`Missing ${label} configuration`);
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (unsupported.length) throw new ConfigError(`Unsupported ${label} fields: ${unsupported.join(', ')}`);
}

export function validateMailSettings(value) {
  const mail = value.mail;
  allowedFields(mail, ['provider', 'address', 'host', 'port', 'security', 'auth'], 'mail');
  const missing = ['address', 'host', 'port', 'security', 'auth'].filter(key => mail[key] == null || mail[key] === '');
  if (missing.length) throw new ConfigError(`Missing mail fields: ${missing.join(', ')}`);
  if (typeof mail.address !== 'string' || typeof mail.host !== 'string') throw new ConfigError('Mail address and host must be strings');
  if (!['ssl', 'starttls', 'plain'].includes(mail.security)) throw new ConfigError(`Unsupported IMAP security mode: ${mail.security}`);
  if (!['password', 'xoauth2'].includes(mail.auth)) throw new ConfigError(`Unsupported IMAP auth mode: ${mail.auth}`);
  if (!Number.isInteger(mail.port) || mail.port < 1 || mail.port > 65535) throw new ConfigError('Mail port must be an integer from 1 to 65535');
  return { ...mail };
}

export function validateCalendarSettings(value) {
  const calendar = value.calendar;
  allowedFields(calendar, ['provider', 'base_url', 'collection_url', 'auth', 'username'], 'calendar');
  if (!calendar.base_url || !calendar.auth) throw new ConfigError('Missing calendar base_url or auth');
  if (!['basic', 'bearer'].includes(calendar.auth)) throw new ConfigError(`Unsupported CalDAV auth mode: ${calendar.auth}`);
  if (calendar.auth === 'basic' && !calendar.username) throw new ConfigError('Calendar username is required for basic authentication');
  for (const key of ['base_url', 'collection_url']) {
    if (calendar[key] == null) continue;
    let url;
    try { url = new URL(calendar[key]); } catch { throw new ConfigError(`Invalid calendar ${key}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ConfigError(`Invalid calendar ${key}`);
  }
  return { ...calendar };
}

export function validateSettings(value) {
  allowedFields(value, ['version', 'timezone', 'mail', 'calendar'], 'settings');
  if (value.version !== 1) throw new ConfigError('Unsupported settings version');
  if (typeof value.timezone !== 'string' || !value.timezone) throw new ConfigError('Missing settings field: timezone');
  validateMailSettings(value);
  validateCalendarSettings(value);
}

export function validateCredentials(value) {
  allowedFields(value, ['version', 'mail', 'calendar'], 'credentials');
  if (value.version !== 1) throw new ConfigError('Unsupported credentials version');
  for (const service of ['mail', 'calendar']) {
    const section = value[service];
    if (!isObject(section) || Object.keys(section).length !== 1 || typeof section.secret !== 'string' || !section.secret) {
      throw new ConfigError(`Invalid ${service} credentials in credentials file`);
    }
  }
}

export class ConfigStore {
  constructor(root = storageDirectory()) {
    this.root = root;
    this.settingsPath = join(root, 'settings.json');
    this.credentialsPath = join(root, 'credentials.json');
    this.statePath = join(root, 'state.json');
  }
  loadSettings() { const value = readJson(this.settingsPath, 'Settings'); validateSettings(value); return value; }
  loadCredentials() { const value = readJson(this.credentialsPath, 'Credentials'); validateCredentials(value); return value; }
  mail(withSecret = true) {
    const value = validateMailSettings(this.loadSettings());
    if (withSecret) value.secret = this.loadCredentials().mail.secret;
    return value;
  }
  calendar(withSecret = true) {
    const value = validateCalendarSettings(this.loadSettings());
    if (withSecret) value.secret = this.loadCredentials().calendar.secret;
    return value;
  }
  checkInitialize(force = false) {
    if (!force && [this.settingsPath, this.credentialsPath].some(path => fs.existsSync(path))) {
      throw new InputError('Configuration already exists. Use --force to replace it.');
    }
  }
  initialize(settings, credentials, force = false) {
    this.checkInitialize(force);
    validateSettings(settings);
    validateCredentials(credentials);
    writeJson(this.settingsPath, settings);
    writeJson(this.credentialsPath, credentials, true);
  }
  show() {
    return {
      directory: this.root, settings_path: this.settingsPath, credentials_path: this.credentialsPath,
      credentials_present: fs.existsSync(this.credentialsPath), settings: this.loadSettings(),
    };
  }
}

export async function promptSecret(message) {
  if (!process.stdin.isTTY) throw new InputError("Cannot read credentials interactively; run 'config init' in a terminal");
  try {
    const value = await password({ message, mask: false, toggleMask: false }, { output: process.stderr });
    if (!value) throw new InputError('Credentials cannot be empty');
    return value;
  } catch (error) {
    if (error.name === 'ExitPromptError') throw new MailCalError('Operation interrupted', 'INTERRUPTED', 130);
    if (error instanceof MailCalError) throw error;
    throw new InputError('Cannot read credentials interactively');
  }
}

export async function configInit(args, store, prompt = promptSecret) {
  store.checkInitialize(args.force);
  const provider = args.mailProvider === 'auto' ? detectMailProvider(args.email) : args.mailProvider;
  let mail;
  if (provider === 'generic') {
    if (!args.mailHost) throw new InputError('Unknown email domain; provide --mail-host for the generic provider');
    mail = { provider, address: args.email, host: args.mailHost, port: 993, security: 'ssl', auth: 'password' };
  } else {
    if (!Object.hasOwn(MAIL_PROVIDERS, provider)) throw new InputError(`Unknown mail provider: ${provider}`);
    const { domains, ...preset } = MAIL_PROVIDERS[provider];
    mail = { provider, address: args.email, ...preset };
  }
  for (const [key, option] of [['host', 'mailHost'], ['port', 'mailPort'], ['security', 'mailSecurity'], ['auth', 'mailAuth']]) {
    if (args[option] !== undefined) mail[key] = args[option];
  }
  const calendar = { provider: args.calendarProvider, ...CALENDAR_PROVIDERS[args.calendarProvider] };
  for (const [key, option] of [['base_url', 'calendarUrl'], ['collection_url', 'calendarCollectionUrl'], ['username', 'calendarUser'], ['auth', 'calendarAuth']]) {
    if (args[option] !== undefined) calendar[key] = args[option];
  }
  const settings = { version: 1, timezone: args.timezone, mail, calendar };
  validateSettings(settings);
  const mailSecret = await prompt(mail.auth === 'xoauth2' ? 'Mail OAuth token:' : 'Mail password or app password:');
  const calendarSecret = args.reuseMailSecret ? mailSecret : await prompt(calendar.auth === 'bearer' ? 'Calendar OAuth token:' : 'Calendar password or app password:');
  store.initialize(settings, { version: 1, mail: { secret: mailSecret }, calendar: { secret: calendarSecret } }, args.force);
  return { settings_path: store.settingsPath, credentials_path: store.credentialsPath, mail_provider: provider, calendar_provider: args.calendarProvider };
}
