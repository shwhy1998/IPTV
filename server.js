import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { createEpg, guideId } from './epg.js';

const port = Number(process.env.PORT || 8787);
const fnosSocket = process.env.FNOS_SOCKET;
const gatewayPrefix = '/app/iptv-manager';
const maxSettingsBytes = 32 * 1024 * 1024;
const data = process.env.DATA_DIR ? pathToFileURL(resolve(process.env.DATA_DIR) + sep) : new URL('./data/', import.meta.url);
const publicBase = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : '';
const stateFile = new URL('settings.json', data);
const tempFile = new URL('settings.tmp', data);
const defaults = {
  epgRefreshTimes: ['00:40', '06:40', '13:40', '18:40'],
  epgSources: [{ id: 'sh-telecom', name: '上海电信', url: 'https://epg.deny.vip/sh/tel-epg.xml' }],
  fcc: '',
  fccType: 'telecom',
  channels: []
};
await mkdir(data, { recursive: true });
let state = await readFile(stateFile, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return defaults;
  throw error;
});
const migrate = !state.epgSources;
if (migrate) {
  state.epgSources = state.epg ? [{
    id: 'sh-telecom',
    name: state.epg === defaults.epgSources[0].url ? '上海电信' : '原有 EPG',
    url: state.epg
  }] : [];
  for (const channel of state.channels) channel.epgSourceId = channel.epgId ? state.epgSources[0]?.id ?? '' : '';
}
state.epgRefreshTimes ??= defaults.epgRefreshTimes;
delete state.epg;
delete state.router;
if (migrate) {
  await writeFile(tempFile, JSON.stringify(state, null, 2));
  await rename(tempFile, stateFile);
}
let pendingSave = Promise.resolve();
const epg = await createEpg(new URL('epg/', data), () => state.epgSources, () => state.epgRefreshTimes);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function httpUrl(value) {
  return /^https?:\/\//i.test(value) && URL.canParse(value);
}

function address(value) {
  const [ip, portNumber, extra] = value.split(':');
  return isIPv4(ip) && /^\d{1,5}$/.test(portNumber) &&
    Number(portNumber) > 0 && Number(portNumber) <= 65535 && extra === undefined;
}

function validate(next) {
  next.epgRefreshTimes ??= state.epgRefreshTimes;
  const times = next.epgRefreshTimes;
  check(Array.isArray(times) && times.length > 0 && times.every(time =>
    typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)), '请至少填写一个 24 小时制刷新时间，例如 06:40');
  next.epgRefreshTimes = [...new Set(times)].sort();
  const sources = new Set();
  for (const source of next.epgSources) {
    check(/^[a-z0-9-]+$/.test(source.id) && !sources.has(source.id), 'EPG 源 ID 无效或重复');
    check(source.name.trim() && httpUrl(source.url), '请输入 EPG 源名称和有效的 XMLTV 地址');
    sources.add(source.id);
  }
  check(!next.fcc || address(next.fcc), '默认 FCC 地址应为 IPv4:端口');
  const routes = new Set();
  for (const channel of next.channels) {
    check(!channel.epgSourceId || sources.has(channel.epgSourceId), '频道关联的 EPG 源不存在');
    check(channel.name.trim() && !/[,/]/.test(channel.name), '频道名不能为空或包含逗号、斜杠');
    check(!channel.group.includes('/'), '分组名不能包含斜杠');
    check(channel.lines.length, `请给 ${channel.name} 添加线路`);
    check(!channel.logo || httpUrl(channel.logo) ||
      /^data:image\/(png|jpeg|webp|gif);base64,[\w+/=]+$/.test(channel.logo), '请使用 HTTP 台标或上传图片');
    for (const line of channel.lines) {
      const [source, target] = line.target.split('@');
      const multicast = target ?? source;
      const first = Number(multicast.split('.')[0]);
      check(address(multicast) && first >= 224 && first <= 239 &&
        (target === undefined || (isIPv4(source) && line.target.split('@').length === 2)) &&
        ['rtp', 'udp'].includes(line.protocol), `无效的组播地址 ${line.target}`);
      check(channel.lines.length === 1 || line.label, `请为 ${channel.name} 的每条线路填写标签`);
      check(!/[$/]/.test(line.label), '线路标签不能包含美元符号或斜杠');
      check(line.mode !== 'custom' || address(line.fcc), '线路 FCC 地址应为 IPv4:端口');
      const fcc = line.mode === 'custom' || (line.mode === 'inherit' && next.fcc);
      check(!fcc || line.protocol === 'rtp', 'FCC 用于 RTP 线路。UDP 线路请选择关闭 FCC');
      const route = [channel.group, channel.name, line.label].filter(Boolean).join('/');
      check(!routes.has(route), `频道线路路径重复 ${route}`);
      routes.add(route);
    }
  }
}

function playlist(origin) {
  const attribute = value => value.replace(/["\r\n]/g, ' ').trim();
  const source = state.epgSources.length === 1 ? state.epgSources[0] : null;
  const directGuide = source && !epg.hasCache(source);
  const guide = directGuide ? source.url : state.epgSources.length ? `${origin}/epg.xml` : '';
  const entries = [guide ? `#EXTM3U x-tvg-url="${attribute(guide)}"` : '#EXTM3U'];
  for (const channel of state.channels) {
    const logo = channel.logo.startsWith('data:') ? `${origin}/logos/${channel.id}` : channel.logo;
    const id = channel.epgSourceId && channel.epgId
      ? directGuide ? channel.epgId : guideId(channel.epgSourceId, channel.epgId)
      : '';
    const metadata = Object.entries({
      'tvg-id': id, 'tvg-name': channel.name, 'tvg-logo': logo, 'group-title': channel.group
    }).filter(([, value]) => value).map(([key, value]) => `${key}="${attribute(value)}"`);
    entries.push([`#EXTINF:-1`, ...metadata].join(' ') + ',' + channel.name.replace(/[\r\n]/g, ' '));
    for (const line of channel.lines) {
      const fcc = line.mode === 'inherit' ? state.fcc : line.mode === 'custom' ? line.fcc : '';
      const type = line.mode === 'inherit' ? state.fccType : line.fccType;
      const query = fcc ? `/?fcc=${fcc}${type === 'huawei' ? '&fcc-type=huawei' : ''}` : '';
      entries.push(`${line.protocol}://${line.target}${query}${line.label ? '$' + line.label : ''}`);
    }
  }
  return entries.join('\n') + '\n';
}

function representation(body) {
  return {
    body,
    etag: `W/"${createHash('sha256').update(body).digest('base64url')}"`
  };
}

const assets = new Map();
for (const [path, filename, type] of [
  ['/', 'index.html', 'text/html'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css']
]) {
  const body = await readFile(new URL(`./public/${filename}`, import.meta.url));
  assets.set(path, { ...representation(body), type: type + '; charset=utf-8' });
}
let guideResponse;

async function request(req, res, gateway = false) {
  const origin = publicBase || `http://${req.headers.host}`;
  const url = new URL('http://localhost' + (req.url.startsWith('/') ? req.url : '/invalid-request'));
  const reading = req.method === 'GET' || req.method === 'HEAD';
  let { pathname } = url;
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const json = (value, status = 200) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
  const sendCached = (type, entry, compressed = false) => {
    const headers = { 'Cache-Control': 'no-cache', ETag: entry.etag };
    if (compressed) headers.Vary = 'Accept-Encoding';
    const tags = req.headers['if-none-match']?.split(',').map(tag => tag.trim());
    if (tags?.includes(entry.etag) || tags?.includes('*')) return send(304, type, undefined, headers);
    const acceptsGzip = /(?:^|,)\s*gzip\s*(?:;\s*q=(?!0(?:\.0*)?(?:\s*,|\s*$))[\d.]+)?\s*(?:,|$)/i.test(req.headers['accept-encoding'] || '');
    if (compressed && acceptsGzip) {
      entry.gzip ??= gzipSync(entry.body, { level: 3 });
      headers['Content-Encoding'] = 'gzip';
      return send(200, type, entry.gzip, headers);
    }
    return send(200, type, entry.body, headers);
  };
  try {
    if (gateway) {
      if (!/^\d+$/.test(req.headers['x-trim-userid'] || '') || req.headers['x-trim-isadmin'] !== 'true') {
        return json({ error: '请通过飞牛桌面使用管理员账号打开 IPTV 管理台' }, 403);
      }
      if (pathname === gatewayPrefix && reading) {
        return send(308, 'text/plain', '', { Location: gatewayPrefix + '/' + url.search });
      }
      if (!pathname.startsWith(gatewayPrefix + '/')) return send(404, 'text/plain', 'Not found');
      pathname = pathname.slice(gatewayPrefix.length);
    } else if (fnosSocket && (!reading || !(
      pathname === '/playlist.m3u' || pathname === '/epg.xml' || pathname.startsWith('/logos/')
    ))) {
      return send(404, 'text/plain', 'Not found');
    }
    if (!reading && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
      return json({ error: '跨站请求已拒绝' }, 403);
    }
    if (pathname === '/api/state' && req.method === 'PUT') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return json({ error: '请使用 JSON 提交设置' }, 415);
      }
      if (Number(req.headers['content-length']) > maxSettingsBytes) {
        return json({ error: '配置内容超过 32 MiB' }, 413);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxSettingsBytes) {
          req.resume();
          return json({ error: '配置内容超过 32 MiB' }, 413);
        }
        chunks.push(chunk);
      }
      const next = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      validate(next);
      const save = pendingSave.then(async () => {
        const removed = state.epgSources.filter(source => !next.epgSources.some(item => item.id === source.id));
        await writeFile(tempFile, JSON.stringify(next, null, 2));
        await rename(tempFile, stateFile);
        state = next;
        await Promise.all(removed.map(source => epg.discard(source.id).catch(error => {
          console.error(`无法删除 ${source.name} 的 EPG 缓存: ${error.message}`);
        })));
      });
      pendingSave = save.catch(() => {});
      await save;
      return json({ saved: true });
    }
    if (reading && pathname === '/api/state') return json({ state });
    if (reading && pathname === '/api/epg') return json(epg.report());
    if (pathname === '/api/epg/refresh' && req.method === 'POST') {
      const id = url.searchParams.get('source');
      const sources = id ? state.epgSources.filter(source => source.id === id) : state.epgSources;
      check(sources.length, '没有可刷新的 EPG 源');
      const results = await Promise.allSettled(sources.map(source => epg.refresh(source)));
      const errors = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${sources[index].name}：${result.reason.message}`] : []);
      return json({ sources: epg.report(), errors });
    }
    if (reading && pathname === '/epg.xml') {
      const xml = epg.xmltv(state.channels);
      if (guideResponse?.body !== xml) guideResponse = representation(xml);
      return sendCached('application/xml; charset=utf-8', guideResponse, true);
    }
    if (reading && !gateway && pathname === '/playlist.m3u') {
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition', 'attachment; filename="iptv.m3u"');
      return send(200, 'audio/x-mpegurl; charset=utf-8', playlist(origin));
    }
    if (reading && pathname.startsWith('/logos/')) {
      const logo = state.channels.find(channel => channel.id === pathname.slice(7))?.logo;
      const match = logo?.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) return send(200, match[1], Buffer.from(match[2], 'base64'));
    }
    const asset = assets.get(pathname);
    if (reading && asset) return sendCached(asset.type, asset);
    send(404, 'text/plain', 'Not found');
  } catch (error) {
    json({ error: error.message }, 400);
  }
}

const serverOptions = { requestTimeout: 30000, headersTimeout: 10000, keepAliveTimeout: 5000 };
if (fnosSocket) {
  // Only the package account and root (fnOS trim_http_cgi) can connect.
  const previousMask = process.umask(0o077);
  createServer(serverOptions, (req, res) => request(req, res, true)).listen(fnosSocket, () => {
    chmodSync(fnosSocket, 0o600);
    process.umask(previousMask);
    console.log(`IPTV 管理台 ${gatewayPrefix}/`);
  });
}
createServer(serverOptions, (req, res) => request(req, res)).listen(port, '0.0.0.0', () => {
  console.log(fnosSocket ? `IPTV 只读订阅端口 ${port}` : `IPTV 管理台 http://localhost:${port}`);
});
