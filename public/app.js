const main = document.querySelector('#main');
const toast = document.querySelector('#toast');
let state;
let page = 'channels';
let draft;
let groupFilter = '';
let channelQuery = '';
let managingGroups = false;
let epgSources = [];
let editingSource = null;
let logoResults = new Map();
let refreshingLogos = false;
let toastTimer;

const theme = document.querySelector('#theme');
theme.value = document.documentElement.dataset.theme || 'system';
theme.addEventListener('change', () => {
  if (theme.value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.value;
  try {
    localStorage.setItem('iptv-theme', theme.value);
  } catch {}
});

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const attr = escape;
const field = (label, name, value, options = '') =>
  `<label>${label}<input name="${name}" value="${attr(value)}" ${options}></label>`;
const select = (label, name, value, choices) =>
  `<label>${label}<select name="${name}" aria-label="${attr(label)}">${choices.map(([key, text]) =>
    `<option value="${attr(key)}" ${key === value ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select></label>`;
const types = [['telecom', '电信 / 中兴 / 烽火'], ['huawei', '华为']];
const button = (text, action, extra = '') => `<button type="button" data-action="${action}" ${extra}>${text}</button>`;
const sourceKey = (source, id) => source && id ? `${source}:${encodeURIComponent(id)}` : '';
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)),
  byte => byte.toString(16).padStart(2, '0')).join('');

function guideOptions(query, selected) {
  const term = query.trim().toLowerCase();
  const option = (text, value) => `<button type="button" data-action="epg-pick" data-value="${attr(value)}"
    aria-pressed="${value === selected}">${escape(text)}</button>`;
  const groups = epgSources.map(source => {
    const options = source.channels.filter(channel =>
      `${source.name} ${channel.name} ${channel.id}`.toLowerCase().includes(term)
    ).map(channel => option(`${channel.name}（${channel.id}）`, sourceKey(source.id, channel.id))).join('');
    return options ? `<div class="epg-guide-group" role="group" aria-label="${attr(source.name)}">
      <p>${escape(source.name)}</p>${options}</div>` : '';
  }).join('');
  return (term ? '' : option('未关联', '')) + (groups || '<p class="hint epg-no-results">没有匹配的 EPG 频道</p>');
}

function guideLabel(sourceId, id) {
  if (!id) return '未关联';
  const source = epgSources.find(item => item.id === sourceId);
  const channel = source?.channels.find(item => item.id === id);
  return channel ? `${channel.name}（${id}） · ${source.name}` : `当前关联（${id}）`;
}

function guidePicker() {
  const selected = sourceKey(draft.epgSourceId, draft.epgId);
  return `<div class="epg-field">
    <span id="epg-label">EPG 频道 ID</span>
    <input type="hidden" name="epg-channel" value="${attr(selected)}">
    <details class="epg-picker">
      <summary aria-labelledby="epg-label epg-value">
        <span id="epg-value">${escape(guideLabel(draft.epgSourceId, draft.epgId))}</span>
      </summary>
      <div class="epg-menu">
        <input name="epg-search" type="search" aria-label="搜索 EPG 频道" autocomplete="off" placeholder="搜索频道名或 ID">
        <div class="epg-options">${guideOptions('', selected)}</div>
      </div>
    </details>
  </div>`;
}

function groupNames(settings) {
  return [...new Set([...(settings.groups ?? []), ...settings.channels.map(channel => channel.group)])].filter(Boolean);
}

function validateGroupName(name) {
  if (name === '未分组' || /[,/]/.test(name)) throw new Error('分组名不能使用「未分组」、逗号或斜杠');
}

function notice(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = error ? 'visible error' : 'visible';
  toastTimer = setTimeout(() => toast.className = '', error ? 6500 : 3500);
}

async function api(url, options) {
  const response = await fetch(new URL(url.slice(1), document.baseURI), options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

async function save(next, message) {
  await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
  state = next;
  notice(message);
}

function header(title, subtitle, action = '') {
  return `<header class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</header>`;
}

function channelLogo(channel, saved = false) {
  const initials = channel.name.match(/^CCTV-(.+)$/)?.[1] || Array.from(channel.name).slice(0, 2).join('') || '台';
  const source = saved ? './logos/' + encodeURIComponent(channel.id) : channel.logo;
  const logo = channel.logo
    ? `<img class="logo-image" src="${attr(source)}" alt="" loading="lazy" decoding="async">` : '';
  return `<span class="logo" aria-hidden="true"><span class="logo-initials">${escape(initials)}</span>${logo}</span>`;
}

main.addEventListener('load', event => {
  if (event.target.matches('.logo-image')) event.target.parentElement.classList.add('logo-loaded');
}, true);

function logoManager() {
  const hasRemote = state.channels.some(channel => /^https?:\/\//i.test(channel.logo));
  const rows = state.channels.map(channel => {
    const uploaded = channel.logo.startsWith('data:');
    const result = logoResults.get(channel.id);
    const status = result?.source === channel.logo
      ? result.error ? `刷新失败：${result.error}` : '已刷新'
      : channel.logo ? uploaded ? '已上传' : '图片链接' : '未设置台标';
    return `<li class="row logo-row">
      ${channelLogo(channel, true)}
      <div class="grow source-info"><strong>${escape(channel.name)}</strong>
        <small>${escape(status)}</small>
        ${channel.logo && !uploaded ? `<small class="source-url">${escape(channel.logo)}</small>` : ''}</div>
      ${button('编辑台标', 'edit-logo', `data-id="${attr(channel.id)}" aria-label="编辑 ${attr(channel.name)} 的台标"`)}
    </li>`;
  }).join('');
  return header('台标管理', '按频道查看和编辑台标。刷新全部会重新下载图片链接。',
    button(refreshingLogos ? '正在刷新…' : '刷新全部台标', 'refresh-logos',
      `class="primary" ${hasRemote && !refreshingLogos ? '' : 'disabled'}`)) +
    (rows ? `<ul class="panel logo-list" aria-label="频道台标">${rows}</ul>`
      : '<p class="panel empty-group">添加频道后，可在这里管理台标。</p>');
}

function channelList() {
  const groups = groupNames(state);
  const hasUngrouped = state.channels.some(channel => !channel.group);
  if (groupFilter && ![...groups, ...(hasUngrouped ? [''] : [])].includes(groupFilter.slice(1))) groupFilter = '';
  const channels = state.channels.map((channel, index) => ({ channel, index }))
    .filter(({ channel }) => !groupFilter || ':' + channel.group === groupFilter);
  return header('频道与线路', `${state.channels.length} 个频道，${state.channels.reduce((total, channel) => total + channel.lines.length, 0)} 条组播线路`,
    `<div class="actions">${button('分组管理', 'groups')}${button('＋ 新增频道', 'new', 'class="primary"')}</div>`) +
    (state.channels.length || groups.length ? `<section class="panel channel-panel" aria-label="频道列表">
      <div class="group-tabs" aria-label="频道分组">${[['', '全部', state.channels.length], ...groups.map(group => [':' + group, group, state.channels.filter(channel => channel.group === group).length]), ...(hasUngrouped ? [[':', '未分组', state.channels.filter(channel => !channel.group).length]] : [])].map(([value, name, count]) => button(escape(name) + '<span>' + count + '</span>', 'filter-group', `data-value="${attr(value)}" aria-pressed="${value === groupFilter}"`)).join('')}</div><div class="list-head">
      ${field('搜索频道', 'channel-search', channelQuery, 'type="search" placeholder="输入频道名或组播地址"')}
      ${select('按分组筛选', 'group-filter', groupFilter, [
        ['', '全部分组'], ...groups.map(group => [':' + group, group]), ...(hasUngrouped ? [[':', '未分组']] : [])
      ])}<p class="list-count" aria-live="polite"></p></div>
      <div class="channel-columns" aria-hidden="true"><span>频道</span><span>线路</span><span>FCC</span><span>操作</span></div>${
      channels.map(({ channel, index }, position) => {
        const previous = channels.slice(0, position).findLast(item => item.channel.group === channel.group);
        const next = channels.slice(position + 1).find(item => item.channel.group === channel.group);
        const fcc = channel.lines.some(line => line.mode === 'custom' ? line.fcc : line.mode === 'inherit' && state.fcc);
        const labels = channel.lines.map(line => line.label || line.protocol.toUpperCase());
        const terms = [channel.name, channel.group, ...channel.lines.map(line => line.target), ...labels].join(' ').toLowerCase();
        return `<article class="row channel-row" data-search="${attr(terms)}">
        <div class="channel-identity">${channelLogo(channel, true)}<div><strong>${escape(channel.name)}</strong>
        <small class="channel-address">${escape(channel.lines[0]?.target || '')}</small></div></div>
        <div class="line-labels" aria-label="线路">${labels.map(label => `<span>${escape(label)}</span>`).join('')}</div>
        <div class="fcc-status ${fcc ? 'is-enabled' : ''}" aria-label="FCC ${fcc ? '已配置' : '未配置'}">${fcc ? '已配置' : '未配置'}</div>
        <div class="actions">${button('↑', 'move', `data-index="${index}" data-target="${previous?.index ?? ''}" aria-label="上移 ${attr(channel.name)}" ${previous ? '' : 'disabled'}`)}
        ${button('↓', 'move', `data-index="${index}" data-target="${next?.index ?? ''}" aria-label="下移 ${attr(channel.name)}" ${next ? '' : 'disabled'}`)}
        ${button('编辑', 'edit', `data-id="${channel.id}"`)}</div></article>`;
      }).join('')
      }<p class="empty-group channel-empty" hidden>没有匹配的频道。</p></section>` : `<section class="empty"><div aria-hidden="true" class="signal"><i></i><i></i><i></i><i></i></div>
      <h2>频道列表为空</h2><p>添加第一个频道，然后填入组播地址。</p>${button('新增频道', 'new')}</section>`);
}

function filterChannels() {
  const count = main.querySelector('.list-count');
  if (!count) return;
  const term = channelQuery.trim().toLowerCase();
  let visible = 0;
  for (const row of main.querySelectorAll('.channel-row')) {
    row.hidden = !row.dataset.search.includes(term);
    if (!row.hidden) visible++;
  }
  count.textContent = `${visible} 个频道`;
  count.hidden = !term && !groupFilter;
  main.querySelector('.channel-empty').hidden = visible > 0;
}

function groupManager() {
  const groups = groupNames(state);
  const rows = groups.map((group, index) => {
    const count = state.channels.filter(channel => channel.group === group).length;
    return `<form class="row group-row" data-group-index="${index}">
      ${field('分组名', 'group-name', group, 'required')}
      <span class="hint">${count} 个频道</span>
      <div class="actions">
        <button type="submit">保存名称</button>
        ${button('↑', 'group-up', `data-index="${index}" aria-label="上移 ${attr(group)}" ${index === 0 ? 'disabled' : ''}`)}
        ${button('↓', 'group-down', `data-index="${index}" aria-label="下移 ${attr(group)}" ${index === groups.length - 1 ? 'disabled' : ''}`)}
        ${button('删除', 'group-delete', `data-index="${index}" class="danger" aria-label="删除 ${attr(group)}"`)}
      </div></form>`;
  }).join('');
  return header('分组管理', '分组排序会同步到频道列表和 M3U。', button('返回频道与线路', 'groups-back')) +
    `<form id="group-create" class="panel row group-row">
      ${field('新分组名', 'group-name', '', 'required placeholder="例如 体育"')}
      <button type="submit" class="primary">新增分组</button>
    </form><section class="panel">${rows || '<p class="empty-group">暂无分组。</p>'}</section>`;
}

const newLine = () => ({ label: '', protocol: 'rtp', target: '', mode: 'inherit', fcc: '', fccType: 'telecom' });
function logoFields() {
  const saved = state.channels.some(channel => channel.id === draft.id && channel.logo === draft.logo);
  return `<div class="logo-editor">
    <div id="logo-preview">${channelLogo(draft, saved)}</div>
    <div class="grid">
      ${field('图片链接', 'logo-url', draft.logo.startsWith('data:') ? '' : draft.logo, 'type="url" placeholder="https://…"')}
      <label>上传图片<input type="file" name="logo-file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
    </div>
    ${button('移除台标', 'logo-remove', draft.logo ? '' : 'disabled')}
  </div>`;
}

function logoEditor() {
  return header('编辑台标', escape(draft.name)) +
    `<form id="logo-form" class="panel form-stack">${logoFields()}
      <div class="actions"><button class="primary">保存台标</button>${button('取消', 'cancel')}</div>
    </form>`;
}

function editor() {
  const lines = draft.lines.map((line, index) => `<fieldset class="stream-line">
    <legend>线路 ${index + 1}</legend><div class="grid">
      ${select('协议', 'protocol', line.protocol, [['rtp', 'RTP'], ['udp', 'UDP']])}
      ${field('组播地址', 'target', line.target, 'required placeholder="239.x.x.x:端口"')}
      ${field('线路标签', 'label', line.label, 'placeholder="例如 高清"')}
      ${select('FCC', 'mode', line.mode, [['inherit', '使用默认 FCC'], ['off', '关闭'], ['custom', '单独设置']])}
      <div class="grid wide custom" ${line.mode !== 'custom' ? 'hidden' : ''}>
        ${field('FCC 地址', 'fcc', line.fcc, 'placeholder="IPv4:端口"')}
        ${select('FCC 协议', 'fccType', line.fccType, types)}
      </div></div><div class="actions line-actions">
      ${button('上移', 'line-up', `data-index="${index}" ${index === 0 ? 'disabled' : ''}`)}
      ${button('下移', 'line-down', `data-index="${index}" ${index === draft.lines.length - 1 ? 'disabled' : ''}`)}
      ${button('移除线路', 'line-remove', `data-index="${index}" ${draft.lines.length === 1 ? 'disabled' : ''}`)}
    </div></fieldset>`).join('');
  return header(draft.id ? '编辑频道' : '新增频道', '同一频道的线路共用台标和 EPG。') +
    `<form id="channel-form" class="panel form-stack"><div class="grid">
      ${field('频道名', 'name', draft.name, 'required placeholder="例如 CCTV-1"')}
      ${select('分组', 'group', draft.group, [['', '未分组'], ...groupNames(state).map(group => [group, group])])}
      ${guidePicker()}
      ${epgSources.some(source => source.channels.length) ? '' : '<p class="hint wide">先到设置刷新 EPG 源，即可搜索和选择频道。</p>'}
    </div><fieldset><legend>频道台标</legend>
      ${logoFields()}
    </fieldset><div class="section-title"><h2>组播线路</h2>${button('＋ 添加线路', 'line-add')}</div>
    <p class="hint">多条线路需要各自的标签。组播地址也支持「源 IP@组播 IP:端口」。</p>
    ${lines}<div class="actions"><button class="primary">保存频道</button>${button('取消', 'cancel')}
    ${draft.id ? button('删除频道', 'delete', 'class="danger"') : ''}</div></form>`;
}

function sourceStatus(source) {
  const cached = epgSources.find(item => item.id === source.id && item.url === source.url);
  return cached?.refreshedAt ? `${cached.channels.length} 个频道 · 上次刷新 ${new Date(cached.refreshedAt)
    .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : '尚未刷新';
}

function settingsPage() {
  const sourceForm = source => `<form class="source-form form-stack" id="source-editor" data-source="${source?.id ?? ''}">
    <div class="grid">${field('源名称', 'source-name', source?.name, 'required')}
    ${field('XMLTV 地址', 'source-url', source?.url, 'type="url" required placeholder="https://…/epg.xml.gz"')}</div>
    <div class="actions"><button class="primary">${source ? '保存来源' : '添加来源'}</button>
    ${button('取消', 'source-cancel')}</div></form>`;
  const sources = state.epgSources.map(source => `<article class="source-item">
    <div class="row source-row">
      <div class="grow source-info"><strong>${escape(source.name)}</strong>
        <small class="source-url">${escape(source.url)}</small>
        <small data-source-status="${source.id}">${sourceStatus(source)}</small></div>
      <div class="actions">
        ${button('编辑', 'source-edit', `data-id="${source.id}" aria-label="编辑 ${attr(source.name)}"`)}
        ${button('刷新', 'read-epg', `data-id="${source.id}" aria-label="刷新 ${attr(source.name)}"`)}
        ${button('删除', 'remove-source', `data-id="${source.id}" class="danger" aria-label="删除 ${attr(source.name)}"`)}
      </div>
    </div>${editingSource === source.id ? sourceForm(source) : ''}
  </article>`).join('');
  return header('设置', '管理节目单来源和默认 FCC。') +
    `<section class="panel form-stack"><div class="section-title"><h2>电子节目单</h2>
      <div class="actions">${button('刷新全部', 'read-epg', state.epgSources.length ? '' : 'disabled')}
      ${button('＋ 添加 EPG 源', 'source-add', 'class="primary"')}</div></div>
      <form id="epg-schedule" class="source-form form-stack">
        ${field('每日刷新时间（北京时间）', 'refresh-times', state.epgRefreshTimes.join('、'), 'required placeholder="00:40、06:40、13:40、18:40"')}
        <div class="actions"><p class="hint grow">使用 24 小时制，多个时间用逗号、顿号或空格分隔。</p><button>保存时间</button></div>
      </form>
      <div class="source-list">${sources || '<p class="empty-group">暂无 EPG 源。</p>'}
      ${editingSource === '' ? sourceForm() : ''}</div>
    </section><form id="settings-form" class="panel form-stack"><h2>默认 FCC</h2>
      <div class="grid">${field('默认 FCC 地址', 'fcc', state.fcc, 'placeholder="IPv4:端口"')}
      ${select('默认 FCC 协议', 'fccType', state.fccType, types)}</div>
      <div><button class="primary">保存设置</button></div>
    </form>`;
}

function render() {
  for (const item of document.querySelectorAll('nav [data-page]')) {
    if (item.dataset.page === page) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  main.innerHTML = ({
    channels: () => draft ? editor() : managingGroups ? groupManager() : channelList(),
    logos: () => draft ? logoEditor() : logoManager(),
    settings: settingsPage
  })[page]();
  filterChannels();
}

function readDraft() {
  const form = document.querySelector('#channel-form');
  Object.assign(draft, Object.fromEntries(['name', 'group'].map(name => [name, form.elements[name].value.trim()])));
  const [source = '', id = ''] = form.elements['epg-channel'].value.split(':');
  draft.epgSourceId = source;
  draft.epgId = decodeURIComponent(id);
  const logoUrl = form.elements['logo-url'].value.trim();
  if (logoUrl || !draft.logo.startsWith('data:')) draft.logo = logoUrl;
  draft.lines = Array.from(form.querySelectorAll('.stream-line'), row =>
    Object.fromEntries(Array.from(row.querySelectorAll('[name]'), input => [input.name, input.value.trim()])));
}

function swap(list, from, to) {
  [list[from], list[to]] = [list[to], list[from]];
}

function sortChannelsByGroup(settings) {
  const groups = [...groupNames(settings), ''];
  const order = new Map(groups.map((group, index) => [group, index]));
  settings.channels.sort((a, b) => order.get(a.group) - order.get(b.group));
}

async function changeGroup(action, index) {
  const next = structuredClone(state);
  next.groups = groupNames(next);
  const group = next.groups[index];
  if (action === 'group-delete') {
    const channels = next.channels.filter(channel => channel.group === group);
    const message = channels.length
      ? `删除「${group}」？其中 ${channels.length} 个频道将移到「未分组」。`
      : `删除空分组「${group}」？`;
    if (!confirm(message)) return;
    next.groups.splice(index, 1);
    for (const channel of channels) channel.group = '';
    sortChannelsByGroup(next);
    await save(next, '已删除分组');
    if (groupFilter === ':' + group) groupFilter = channels.length ? ':' : '';
  } else {
    swap(next.groups, index, index + (action === 'group-up' ? -1 : 1));
    sortChannelsByGroup(next);
    await save(next, '已保存分组顺序');
  }
}

async function refreshEpg(control, id) {
  control.disabled = true;
  try {
    const query = id ? '?source=' + encodeURIComponent(id) : '';
    const result = await api('/api/epg/refresh' + query, { method: 'POST' });
    epgSources = result.sources;
    for (const element of main.querySelectorAll('[data-source-status]')) {
      const source = state.epgSources.find(item => item.id === element.dataset.sourceStatus);
      if (source) element.textContent = sourceStatus(source);
    }
    notice(result.errors.length ? result.errors.join('；') : '节目单已刷新', Boolean(result.errors.length));
  } finally {
    control.disabled = false;
  }
}

document.addEventListener('click', async event => {
  const picker = main.querySelector('.epg-picker[open]');
  if (picker && !picker.contains(event.target)) picker.open = false;
  const control = event.target.closest('[data-page], [data-action]');
  if (!control || !state) return;
  const { page: destination, action, id, index } = control.dataset;
  try {
    if (destination) {
      page = destination;
      draft = null;
      managingGroups = false;
      editingSource = null;
      if (page === 'settings') epgSources = await api('/api/epg');
    } else if (action === 'filter-group') {
      groupFilter = control.dataset.value;
    } else if (action === 'source-add' || action === 'source-edit' || action === 'source-cancel') {
      editingSource = action === 'source-cancel' ? null : id ?? '';
      render();
      main.querySelector('#source-editor [name="source-name"]')?.focus();
      return;
    } else if (action === 'epg-pick') {
      const form = control.form;
      const [source = '', guide = ''] = control.dataset.value.split(':');
      const summary = picker.querySelector('summary');
      form.elements['epg-channel'].value = control.dataset.value;
      summary.querySelector('span').textContent = guideLabel(source, decodeURIComponent(guide));
      picker.open = false;
      summary.focus();
      return;
    } else if (action === 'groups' || action === 'groups-back') {
      managingGroups = action === 'groups';
    } else if (action.startsWith('group-')) {
      control.disabled = true;
      try {
        await changeGroup(action, Number(index));
      } finally {
        control.disabled = false;
      }
    } else if (action === 'new') {
      page = 'channels';
      epgSources = await api('/api/epg');
      draft = { name: '', group: groupFilter.slice(1), logo: '', epgId: '', epgSourceId: '', lines: [newLine()] };
    } else if (action === 'edit') {
      epgSources = await api('/api/epg');
      draft = structuredClone(state.channels.find(channel => channel.id === id));
    } else if (action === 'edit-logo') {
      draft = structuredClone(state.channels.find(channel => channel.id === id));
    } else if (action === 'refresh-logos') {
      refreshingLogos = true;
      control.disabled = true;
      control.textContent = '正在刷新…';
      try {
        const { results } = await api('/api/logos/refresh', { method: 'POST' });
        logoResults = new Map(results.map(result => [result.id, result]));
        const failed = results.filter(result => result.error).length;
        notice(`台标刷新完成，成功 ${results.length - failed} 个，失败 ${failed} 个`, failed > 0);
      } finally {
        refreshingLogos = false;
        if (page === 'logos' && !draft) {
          render();
          main.querySelector('[data-action="refresh-logos"]')?.focus();
        }
      }
      return;
    } else if (action === 'cancel') {
      draft = null;
    } else if (action === 'logo-remove') {
      if (page === 'channels') readDraft();
      draft.logo = '';
    } else if (action.startsWith('line-')) {
      readDraft();
      const position = Number(index);
      if (action === 'line-add') draft.lines.push(newLine());
      if (action === 'line-remove') draft.lines.splice(position, 1);
      if (action === 'line-up') swap(draft.lines, position, position - 1);
      if (action === 'line-down') swap(draft.lines, position, position + 1);
    } else if (action === 'read-epg') {
      await refreshEpg(control, id);
      return;
    } else {
      const next = structuredClone(state);
      const position = Number(index);
      if (action === 'remove-source') {
        const source = next.epgSources.find(item => item.id === id);
        if (!confirm(`删除「${source.name}」？使用此源的频道会解除 EPG 关联。`)) return;
        next.epgSources = next.epgSources.filter(item => item.id !== id);
        for (const channel of next.channels.filter(item => item.epgSourceId === id)) {
          channel.epgId = '';
          channel.epgSourceId = '';
        }
      }
      if (action === 'move') swap(next.channels, position, Number(control.dataset.target));
      if (action === 'delete') {
        if (!confirm(`删除「${draft.name}」及其所有线路？`)) return;
        next.channels = next.channels.filter(channel => channel.id !== draft.id);
      }
      await save(next, '已保存');
      if (action === 'delete') draft = null;
      if (action === 'remove-source' && editingSource === id) editingSource = null;
    }
    render();
  } catch (error) {
    notice(error.message, true);
  }
});

function updateLogoPreview(form) {
  const url = form.elements['logo-url'].value.trim();
  const logo = /^https?:\/\//i.test(url) && URL.canParse(url) ? url :
    !url && draft.logo.startsWith('data:') ? draft.logo : '';
  const name = form.elements.name?.value.trim() || draft.name;
  form.querySelector('#logo-preview').innerHTML = channelLogo({ name, logo });
  form.querySelector('[data-action="logo-remove"]').disabled = !url && !logo;
}

main.addEventListener('input', event => {
  if (event.target.name === 'channel-search') {
    channelQuery = event.target.value;
    filterChannels();
  }
  if (event.target.name === 'epg-search') {
    const form = event.target.form;
    form.querySelector('.epg-options').innerHTML = guideOptions(event.target.value, form.elements['epg-channel'].value);
  }
  if (['logo-url', 'name'].includes(event.target.name) &&
      ['channel-form', 'logo-form'].includes(event.target.form?.id)) {
    updateLogoPreview(event.target.form);
  }
});

main.addEventListener('toggle', event => {
  if (!event.target.matches('.epg-picker') || !event.target.open) return;
  const search = event.target.querySelector('[name="epg-search"]');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  search.focus();
}, true);

main.addEventListener('keydown', event => {
  const picker = event.target.closest('.epg-picker[open]');
  if (!picker) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    picker.open = false;
    picker.querySelector('summary').focus();
  } else if (event.key === 'Enter' && event.target.name === 'epg-search') {
    event.preventDefault();
    picker.querySelector('.epg-options button')?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const options = [...picker.querySelectorAll('.epg-options button')];
    const index = options.indexOf(event.target);
    const target = options[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (target) {
      event.preventDefault();
      target.focus();
    } else if (index === 0 && event.key === 'ArrowUp') {
      event.preventDefault();
      picker.querySelector('[name="epg-search"]').focus();
    }
  }
});

main.addEventListener('change', async event => {
  if (event.target.name === 'group-filter') {
    groupFilter = event.target.value;
    render();
    main.querySelector('[name="group-filter"]').focus();
  }
  if (event.target.name === 'logo-file') {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    const submit = input.form.querySelector('button[type="submit"], button.primary');
    submit.disabled = true;
    try {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
      const logo = await imageData(file);
      if (!input.isConnected || input.files[0] !== file) return;
      draft.logo = logo;
      input.form.elements['logo-url'].value = '';
      updateLogoPreview(input.form);
    } catch (error) {
      input.value = '';
      notice(error.message, true);
    } finally {
      submit.disabled = false;
    }
  }
  if (event.target.name === 'mode') {
    event.target.closest('fieldset').querySelector('.custom').hidden = event.target.value !== 'custom';
  }
  if (event.target.name === 'protocol' && event.target.value === 'udp') {
    const row = event.target.closest('fieldset');
    row.querySelector('[name=mode]').value = 'off';
    row.querySelector('.custom').hidden = true;
  }
});

function imageData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}

main.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const values = new FormData(form);
  const value = name => String(values.get(name) ?? '').trim();
  const next = structuredClone(state);
  const submitter = event.submitter;
  if (submitter) submitter.disabled = true;
  try {
    if (form.id === 'group-create' || form.hasAttribute('data-group-index')) {
      const name = value('group-name');
      const groups = groupNames(next);
      const index = form.id === 'group-create' ? groups.length : Number(form.dataset.groupIndex);
      const previous = groups[index];
      if (!name) throw new Error('请填写分组名');
      validateGroupName(name);
      if (name !== previous && groups.includes(name)) throw new Error('这个分组已存在');
      groups[index] = name;
      next.groups = groups;
      for (const channel of next.channels) if (channel.group === previous) channel.group = name;
      await save(next, previous ? '已保存分组名称' : '已新增分组');
      if (previous && groupFilter === ':' + previous) groupFilter = ':' + name;
      render();
      return;
    } else if (form.id === 'channel-form') {
      readDraft();
      validateGroupName(draft.group);
      const position = next.channels.findIndex(channel => channel.id === draft.id);
      next.groups = groupNames(next);
      if (position === -1) {
        next.channels.push({ ...draft, id: newId() });
      } else next.channels[position] = draft;
      next.groups = groupNames(next);
      sortChannelsByGroup(next);
    } else if (form.id === 'logo-form') {
      const channel = next.channels.find(channel => channel.id === draft.id);
      channel.logo = value('logo-url') || (draft.logo.startsWith('data:') ? draft.logo : '');
    } else if (form.id === 'source-editor') {
      const id = form.dataset.source;
      const source = { id: id || newId(), name: value('source-name'), url: value('source-url') };
      if (id) next.epgSources = next.epgSources.map(item => item.id === id ? source : item);
      else next.epgSources.push(source);
    } else if (form.id === 'epg-schedule') {
      next.epgRefreshTimes = value('refresh-times').split(/[、，,\s]+/).filter(Boolean).map(time => time.padStart(5, '0'));
    } else if (form.id === 'settings-form') {
      for (const name of ['fcc', 'fccType']) next[name] = value(name);
    }
    await save(next, '已保存');
    if (form.id === 'source-editor') editingSource = null;
    draft = null;
    render();
  } catch (error) {
    notice(error.message, true);
  } finally {
    if (submitter) submitter.disabled = false;
  }
});

try {
  ({ state } = await api('/api/state'));
  render();
} catch (error) {
  notice(error.message, true);
}
