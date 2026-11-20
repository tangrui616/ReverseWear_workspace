import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublic.addSubnet(address, prefix);
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  nonPublic.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicLinkAddress(address) {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address);
  return family === 6 && globalV6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

function publicUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('仅检查标准端口的公开 HTTP(S) 链接。');
  }
  if (base?.protocol === 'https:' && url.protocol === 'http:') throw new Error('跳转降级到 HTTP，请手动确认。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const domain = host.toLowerCase().replace(/\.$/, '');
  if (isIP(host) ? !isPublicLinkAddress(host) : !domain.includes('.') || /\.(?:localhost|local|internal|home\.arpa)$/.test(domain)) {
    throw new Error('本机和内网地址未检查。');
  }
  url.hash = '';
  return url;
}

function requestHeaders(url, method, signal) {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, {
      method, signal, agent: false,
      headers: { 'User-Agent': 'ReverseWear-LinkCheck/1.0', ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}) },
      lookup(hostname, options, done) {
        lookup(hostname, { all: true, family: options.family }).then(addresses => {
          if (!addresses.length || addresses.some(item => !isPublicLinkAddress(item.address))) {
            done(Object.assign(new Error('域名解析到本机或内网地址。'), { code: 'NON_PUBLIC_ADDRESS' }));
            return;
          }
          // Use the addresses that were just checked for this connection.
          if (options.all) done(null, addresses);
          else done(null, addresses[0].address, addresses[0].family);
        }, done);
      },
    }, response => {
      resolve({ status: response.statusCode, location: response.headers.location });
      response.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

const redirects = new Set([301, 302, 303, 307, 308]);
const retryWithGet = new Set([400, 403, 404, 405, 410, 501]);
const networkDetail = error => ({
  ABORT_ERR: '检查超时。', ENOTFOUND: '域名暂无法解析。', EAI_AGAIN: '域名解析暂不可用。',
  NON_PUBLIC_ADDRESS: '域名解析到本机或内网地址。',
})[error.code] ?? (error.code ? '连接或证书验证失败。' : error.message);

export function createManualLinkChecker(workbench, { headers = requestHeaders, timeoutMs = 8_000 } = {}) {
  let active = false;
  async function checkOne(item) {
    const result = { id: item.id, status: 'unknown' };
    if (!item.url) return { ...result, detail: '找不到这条链接，请刷新列表。' };
    try {
      let url = publicUrl(item.url);
      const original = url.href;
      const seen = new Set();
      const signal = AbortSignal.timeout(timeoutMs);
      for (let step = 0; step <= 5; step++) {
        if (seen.has(url.href)) return { ...result, detail: '网站返回循环跳转。' };
        seen.add(url.href);
        let response = await headers(url, 'HEAD', signal);
        if (retryWithGet.has(response.status)) response = await headers(url, 'GET', signal);
        const httpStatus = response.status;
        if (redirects.has(httpStatus) && response.location) {
          url = publicUrl(response.location, url);
          continue;
        }
        const destination = url.href !== original ? url.href : undefined;
        if (httpStatus >= 200 && httpStatus < 300) return { ...result, status: destination ? 'redirect' : 'reachable', httpStatus, destination };
        if ([404, 410].includes(httpStatus)) return { ...result, status: 'dead', httpStatus, destination };
        const detail = [401, 403, 429].includes(httpStatus) ? '网站要求登录、限制请求或拦截了检查。' : '当前响应无法确定链接是否仍有效。';
        return { ...result, httpStatus, destination, detail };
      }
      return { ...result, detail: '跳转次数超过检查上限。' };
    } catch (error) {
      return { ...result, detail: networkDetail(error) };
    }
  }
  return async ({ ids } = {}) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 30 || !ids.every(id => typeof id === 'string' && /^[0-9a-f-]{16,36}$/i.test(id))) {
      throw new Error('请选中 1 至 30 条有效链接。');
    }
    if (active) throw new Error('链接检查正在进行。');
    active = true;
    try {
      const urls = new Map((await workbench.listLinks()).map(item => [item.id, item.url]));
      const selected = [...new Set(ids)];
      const results = new Array(selected.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
        while (next < selected.length) {
          const index = next++;
          const id = selected[index];
          results[index] = await checkOne({ id, url: urls.get(id) });
        }
      }));
      return results;
    } finally {
      active = false;
    }
  };
}
