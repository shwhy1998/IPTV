import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

const options = { ignoreAttributes: false, preserveOrder: true, parseTagValue: false, trimValues: false };
const parser = new XMLParser(options);
const builder = new XMLBuilder(options);
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export function guideId(sourceId, id) {
  return `${sourceId}:${encodeURIComponent(id)}`;
}

function parse(xml) {
  const tv = parser.parse(xml).find(node => Array.isArray(node.tv))?.tv;
  if (!tv) throw new Error('节目单内容不是 XMLTV');
  const channels = tv.filter(node => node.channel && node[':@']?.['@_id']).map(node => {
    const id = node[':@']['@_id'];
    const name = node.channel.find(child => child['display-name'])?.['display-name'][0]?.['#text']?.trim();
    return { id, name: name || id };
  });
  if (!channels.length) throw new Error('XMLTV 中没有频道');
  return { tv, channels };
}

export async function createEpg(directory, getSources, getRefreshTimes) {
  await mkdir(directory, { recursive: true });
  const cache = new Map();
  const inflight = new Map();
  let guideCache;
  function current(source) {
    const entry = cache.get(source.id);
    return entry?.url === source.url ? entry : undefined;
  }

  for (const source of getSources()) {
    try {
      const file = JSON.parse(await readFile(new URL(source.id + '.json', directory), 'utf8'));
      if (file.url === source.url) cache.set(source.id, { ...parse(file.xml), url: file.url, time: file.time });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`无法读取 ${source.name} 的 EPG 缓存: ${error.message}`);
    }
  }

  async function download(source, signal) {
    const response = await fetch(source.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
    if (!response.ok) throw new Error(`节目单服务器返回 HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw new Error('节目单下载超过 32 MiB');
      chunks.push(chunk);
    }
    let bytes = Buffer.concat(chunks, size);
    if (bytes[0] === 31 && bytes[1] === 139) bytes = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
    const xml = bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (XMLValidator.validate(xml) !== true) throw new Error('节目单 XML 格式不正确');
    const parsed = parse(xml);
    if (!getSources().some(item => item.id === source.id && item.url === source.url)) return;
    const time = new Date().toISOString();
    const temporary = new URL(source.id + '.tmp', directory);
    await writeFile(temporary, JSON.stringify({ url: source.url, time, xml }));
    await rename(temporary, new URL(source.id + '.json', directory));
    cache.set(source.id, { ...parsed, url: source.url, time });
    guideCache = undefined;
  }

  function refresh(source) {
    const running = inflight.get(source.id);
    if (running?.url === source.url) return running.promise;
    running?.controller.abort();
    const controller = new AbortController();
    const promise = (running ? running.promise.catch(() => {}) : Promise.resolve())
      .then(() => download(source, controller.signal))
      .finally(() => {
        if (inflight.get(source.id)?.promise === promise) inflight.delete(source.id);
      });
    inflight.set(source.id, { url: source.url, promise, controller });
    return promise;
  }

  async function discard(id) {
    const running = inflight.get(id);
    if (running) {
      running.controller.abort();
      await running.promise.catch(() => {});
    }
    cache.delete(id);
    guideCache = undefined;
    await Promise.all(['.json', '.tmp'].map(extension =>
      rm(new URL(id + extension, directory), { force: true })));
  }

  function report() {
    return getSources().map(source => {
      const entry = current(source);
      return { ...source, refreshedAt: entry?.time ?? null, channels: entry?.channels ?? [] };
    });
  }

  function xmltv(channels) {
    const sources = getSources();
    if (guideCache?.channels === channels && guideCache.sources === sources) return guideCache.xml;
    const mapped = new Map();
    for (const channel of channels) {
      if (!channel.epgSourceId || !channel.epgId) continue;
      if (!mapped.has(channel.epgSourceId)) mapped.set(channel.epgSourceId, new Set());
      mapped.get(channel.epgSourceId).add(channel.epgId);
    }
    const definitions = [];
    const programmes = [];
    for (const source of getSources()) {
      const selected = mapped.get(source.id);
      const entry = current(source);
      if (!selected || !entry) continue;
      for (const node of entry.tv) {
        if (!node.channel && !node.programme) continue;
        const key = node.channel ? '@_id' : '@_channel';
        const attrs = node[':@'];
        if (!selected.has(attrs?.[key])) continue;
        const item = { ...node, ':@': { ...attrs, [key]: guideId(source.id, attrs[key]) } };
        (node.channel ? definitions : programmes).push(item);
      }
    }
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build([{ tv: [...definitions, ...programmes] }]);
    guideCache = { channels, sources, xml };
    return xml;
  }

  function refreshInBackground(sources) {
    for (const source of sources) refresh(source).catch(error => {
      console.warn(`无法刷新 ${source.name} 的 EPG: ${error.message}`);
    });
  }

  let lastSlot = '';
  function checkSchedule() {
    const slot = clock.format(new Date());
    if (!getRefreshTimes().includes(slot.slice(-5)) || slot === lastSlot) return;
    lastSlot = slot;
    refreshInBackground(getSources());
  }
  setInterval(checkSchedule, 10000).unref();
  checkSchedule();
  refreshInBackground(getSources().filter(source => !current(source)));
  return { refresh, discard, report, xmltv, hasCache: source => Boolean(current(source)) };
}
