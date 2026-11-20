import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualLinkChecker, isPublicLinkAddress } from '../desktop_link_check.mjs';

test('manual link checks follow public redirects and verify missing pages with GET', async () => {
  const responses = {
    '/ok': { status: 200 }, '/moved': { status: 302, location: '/ok' },
    '/dead': { status: 410 }, '/head-blocked': { status: 405 },
    '/login': { status: 401 }, '/private': { status: 302, location: 'http://127.0.0.1/' },
    '/loop': { status: 302, location: '/loop' },
  };
  const paths = [...Object.keys(responses), '/absent'];
  const ids = paths.map((_item, index) => String(index).padStart(16, '0'));
  const requests = [];
  const checker = createManualLinkChecker({
    async listLinks() { return paths.slice(0, -1).map((value, index) => ({ id: ids[index], url: 'https://example.org' + value })); },
  }, {
    async headers(url, method) {
      requests.push([url.href, method]);
      return url.pathname === '/head-blocked' && method === 'GET' ? { status: 206 } : responses[url.pathname];
    },
  });
  assert.deepEqual(requests, []);
  const rows = await checker({ ids });
  assert.deepEqual(rows.map(row => row.status), ['reachable', 'redirect', 'dead', 'reachable', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(rows[1].destination, 'https://example.org/ok');
  assert.equal(rows[2].httpStatus, 410);
  assert.ok(requests.some(([url, method]) => url.endsWith('/dead') && method === 'GET'));
  assert.ok(requests.every(([url]) => url.startsWith('https://example.org/')));
});

test('link checker rejects local, reserved and mapped IP addresses', () => {
  for (const address of ['127.0.0.1', '192.168.5.4', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(isPublicLinkAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicLinkAddress(address), true, address);
});
