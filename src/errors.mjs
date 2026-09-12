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

export function normalizeUid(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) {
    throw new InputError(`Invalid message UID: ${text}`);
  }
  return String(Number(text));
}
