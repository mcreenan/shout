import { hostname, networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const normalizeHost = value => value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

export async function networkHosts(extra = process.env.SHOUT_ALLOWED_HOSTS || '') {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', hostname(), `${hostname()}.local`]);
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) {
    if (!address.address.includes('%') && !address.address.startsWith('fe80:')) hosts.add(normalizeHost(address.address));
  }
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
    const self = JSON.parse(stdout).Self;
    if (self?.DNSName) {
      hosts.add(normalizeHost(self.DNSName));
      hosts.add(normalizeHost(self.DNSName.split('.')[0]));
    }
  } catch { /* Tailscale is optional; interface IPs remain available. */ }
  for (const host of extra.split(',').map(h => h.trim()).filter(Boolean)) {
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host) || host.includes('*')) throw new Error('SHOUT_ALLOWED_HOSTS must contain exact hostnames or IP addresses');
    hosts.add(normalizeHost(host));
  }
  return new Set([...hosts].map(normalizeHost));
}

export function requestUrl(request, hosts, port) {
  const host = request.headers.host;
  if (!host || /[\s/@\\?#]/.test(host)) throw new Error('Unrecognized request host');
  const base = new URL(`http://${host}`);
  if (!hosts.has(normalizeHost(base.hostname)) || Number(base.port || 80) !== port) throw new Error('Unrecognized request host');
  const url = new URL(request.url, base);
  if (url.origin !== base.origin) throw new Error('Request origin does not match host');
  if (request.headers.origin && request.headers.origin !== base.origin) throw new Error('Cross-origin requests are not allowed');
  return url;
}

export function accessUrls(hosts, port, bindHost) {
  const names = ['0.0.0.0', '::'].includes(bindHost) ? [...hosts] : [bindHost];
  return names.filter(name => name !== '::1' && !name.includes(':')).map(name => `http://${name}:${port}`);
}
