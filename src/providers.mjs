import { InputError } from './errors.mjs';

const passwordProvider = (domains, host) => ({ domains, host, port: 993, security: 'ssl', auth: 'password' });
export const MAIL_PROVIDERS = {
  qq: passwordProvider(['qq.com', 'foxmail.com'], 'imap.qq.com'),
  netease163: passwordProvider(['163.com'], 'imap.163.com'),
  netease126: passwordProvider(['126.com'], 'imap.126.com'),
  'netease-yeah': passwordProvider(['yeah.net'], 'imap.yeah.net'),
  aliyun: passwordProvider(['aliyun.com'], 'imap.aliyun.com'),
  gmail: { ...passwordProvider(['gmail.com', 'googlemail.com'], 'imap.gmail.com'), auth: 'xoauth2' },
  outlook: { ...passwordProvider(['outlook.com', 'hotmail.com', 'live.com'], 'outlook.office365.com'), auth: 'xoauth2' },
};
export const CALENDAR_PROVIDERS = {
  qq: { base_url: 'https://dav.qq.com/', auth: 'basic' },
  google: { base_url: 'https://apidata.googleusercontent.com/caldav/v2/', auth: 'bearer' },
  generic: { base_url: '', auth: 'basic' },
};
export function detectMailProvider(address) {
  if (!address.includes('@')) throw new InputError('Email address must contain @');
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return Object.entries(MAIL_PROVIDERS).find(([, provider]) => provider.domains.includes(domain))?.[0] ?? 'generic';
}
