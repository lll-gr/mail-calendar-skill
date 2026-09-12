import { ConfigStore } from './config.mjs';
import { StateStore, mailboxKey } from './state.mjs';

// One CLI run handles exactly one command, so the configuration files are read at
// most once per run and the loaded value is reused.
//
// `withSecret` is part of the cache key on purpose: ack, retry and state read the
// settings without ever touching the credentials file, and a single cache slot
// would let an earlier credentialed read defeat that.
export function createContext({ storeFactory = () => new ConfigStore(), stateFactory = path => new StateStore(path) } = {}) {
  let store;
  let state;
  const settings = new Map();
  const config = () => (store ??= storeFactory());
  const stateStore = () => (state ??= stateFactory(config().statePath));
  const memo = (key, load) => {
    if (!settings.has(key)) settings.set(key, load());
    return settings.get(key);
  };
  const mailKey = () => mailboxKey(config().mail(false));
  return {
    config,
    mailKey,
    state: stateStore,
    statePath: () => config().statePath,
    mail: (withSecret = true) => memo(`mail:${withSecret}`, () => config().mail(withSecret)),
    calendar: (withSecret = true) => memo(`calendar:${withSecret}`, () => config().calendar(withSecret)),
    mailbox(folder) {
      // Deliberately the same order the handlers used before: open the state file,
      // read settings, then validate the cursor, so error precedence is unchanged.
      const current = stateStore();
      const key = mailKey();
      return { key, folder, validity: current.currentUidvalidity(key, folder) };
    },
  };
}
