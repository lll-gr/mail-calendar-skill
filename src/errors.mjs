export class MailCalError extends Error {
  constructor(message, code = 'MAILCAL_ERROR', exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}
export class ConfigError extends MailCalError {
  constructor(message) { super(message, 'CONFIG_ERROR', 2); }
}
export class ConnectionFailure extends MailCalError {
  constructor(message) { super(message, 'CONNECTION_FAILED', 3); }
}
export class NotFoundError extends MailCalError {
  constructor(message) { super(message, 'NOT_FOUND', 4); }
}
export class InputError extends MailCalError {
  constructor(message) { super(message, 'INVALID_INPUT', 5); }
}
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A decimal integer that is at least one and fits a safe integer. Numeric strings are
// accepted so a UID read off the wire and the same UID passed on the command line agree.
export function positiveInteger(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function normalizeUid(value) {
  const uid = positiveInteger(value);
  if (uid === undefined) throw new InputError(`Invalid message UID: ${String(value ?? '')}`);
  return String(uid);
}
