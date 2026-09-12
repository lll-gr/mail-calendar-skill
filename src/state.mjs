import { existsSync } from 'node:fs';
import { v5 as uuidv5 } from 'uuid';
import { readJson, writeJson } from './config.mjs';
import { ConfigError, NotFoundError, isObject, normalizeUid } from './errors.mjs';

export const mailboxKey = settings => uuidv5(`${settings.host.toLowerCase()}\x1f${settings.address.toLowerCase()}`, uuidv5.URL);
const emptyState = key => ({ version: 1, mailbox_key: key, folders: Object.create(null) });

export class StateStore {
  constructor(path) {
    this.path = path;
    this.data = existsSync(path) ? readJson(path, 'State') : emptyState('');
    if (this.data.version !== 1 || !isObject(this.data.folders)) throw new ConfigError(`Unsupported or invalid state file: ${path}`);
  }
  save() { writeJson(this.path, this.data, true); }
  ensureMailbox(key) {
    if (this.data.mailbox_key && this.data.mailbox_key !== key) this.data = emptyState(key);
    else this.data.mailbox_key = key;
  }
  folder(key, name, validity, create = false) {
    this.ensureMailbox(key);
    let value = Object.hasOwn(this.data.folders, name) ? this.data.folders[name] : undefined;
    if (!isObject(value) || String(value.uidvalidity ?? '') !== validity) {
      if (!create) return undefined;
      value = { uidvalidity: validity, last_scanned_uid: 0, updated_at: '', messages: Object.create(null) };
      Object.defineProperty(this.data.folders, name, { value, enumerable: true, configurable: true, writable: true });
    }
    if (!isObject(value.messages) || !Number.isSafeInteger(value.last_scanned_uid) || value.last_scanned_uid < 0) {
      throw new ConfigError(`Invalid message state for folder: ${name}`);
    }
    return value;
  }
  cursor(key, name, validity) { return this.folder(key, name, validity)?.last_scanned_uid ?? 0; }
  recordDiscovered(key, name, validity, headers, lastUid) {
    const folder = this.folder(key, name, validity, true);
    const now = new Date().toISOString();
    for (const header of headers) {
      const uid = normalizeUid(header.uid);
      if (!Object.hasOwn(folder.messages, uid)) {
        folder.messages[uid] = {
          message_id: header.message_id ?? '', subject: header.subject ?? '', from: header.from ?? '', to: header.to ?? '', date: header.date ?? '',
          status: 'pending', outcome: '', event_uid: '', discovered_at: now, processed_at: '',
        };
      }
    }
    folder.last_scanned_uid = lastUid;
    folder.updated_at = now;
    this.save();
  }
  pending(key, name, validity, limit) {
    const folder = this.folder(key, name, validity);
    if (!folder) return [];
    return Object.entries(folder.messages).sort(([a], [b]) => Number(a) - Number(b))
      .filter(([, item]) => item.status === 'pending').slice(0, limit)
      .map(([uid, item]) => ({ uid, uidvalidity: validity, message_id: item.message_id ?? '', subject: item.subject ?? '', from: item.from ?? '', to: item.to ?? '', date: item.date ?? '', discovered_at: item.discovered_at ?? '' }));
  }
  acknowledge(key, name, validity, items) {
    const folder = this.folder(key, name, validity);
    if (!folder) throw new NotFoundError(`No stored messages for folder: ${name}`);
    const normalized = items.map(item => ({ ...item, uid: normalizeUid(item.uid) }));
    for (const item of normalized) {
      if (!Object.hasOwn(folder.messages, item.uid)) throw new NotFoundError(`Pending message UID not found: ${item.uid}`);
    }
    const now = new Date().toISOString();
    const acknowledged = normalized.map(item => {
      const result = { uid: item.uid, outcome: String(item.outcome ?? 'processed'), event_uid: String(item.event_uid ?? '') };
      Object.assign(folder.messages[item.uid], { outcome: result.outcome, event_uid: result.event_uid, status: 'processed', processed_at: now });
      return result;
    });
    folder.updated_at = now;
    this.save();
    return acknowledged;
  }
  retry(key, name, validity, uids) {
    const folder = this.folder(key, name, validity);
    if (!folder) throw new NotFoundError(`No stored messages for folder: ${name}`);
    const normalized = uids.map(normalizeUid);
    for (const uid of normalized) {
      if (!Object.hasOwn(folder.messages, uid)) throw new NotFoundError(`Stored message UID not found: ${uid}`);
    }
    for (const uid of normalized) Object.assign(folder.messages[uid], { status: 'pending', outcome: '', event_uid: '', processed_at: '' });
    folder.updated_at = new Date().toISOString();
    this.save();
    return normalized;
  }
  currentUidvalidity(key, name) {
    if (this.data.mailbox_key !== key) throw new ConfigError("State belongs to another mailbox. Run 'mail pending' first.");
    const folder = Object.hasOwn(this.data.folders, name) && this.data.folders[name];
    if (!isObject(folder) || !folder.uidvalidity) throw new ConfigError("No mailbox cursor exists. Run 'mail pending' first.");
    return String(folder.uidvalidity);
  }
  summary(key, name) {
    this.ensureMailbox(key);
    const folder = (Object.hasOwn(this.data.folders, name) && this.data.folders[name]) || {};
    const counts = Object.create(null);
    for (const item of Object.values(folder.messages ?? {})) counts[item.status ?? 'pending'] = (counts[item.status ?? 'pending'] ?? 0) + 1;
    return { path: this.path, folder: name, uidvalidity: folder.uidvalidity ?? '', last_scanned_uid: folder.last_scanned_uid ?? 0, updated_at: folder.updated_at ?? '', counts };
  }
}
