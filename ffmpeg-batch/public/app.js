'use strict';
const $ = id => document.getElementById(id);
const workspaceViews = new WorkspaceDOM.WorkspaceViews($('task-workspace-template'), $('workspace-host'));
const DRAFT_KEY = '__new-task__';
let draftSuffix = '';
const logScrollStates = new Map();
let serverSnapshot = null;
function mountWorkspace(key) {
  const old = workspaceViews.get(workspaceViews.activeKey);
  if (old) {old.sourceEdited = sourceEdited; old.outputEdited = outputEdited;}
  const activated = workspaceViews.activate(key);
  const view = activated.view;
  closedDirs = view.closedDirs;
  openedFiles = view.openedFiles;
  sourceEdited = view.sourceEdited;
  outputEdited = view.outputEdited;
  if (!view.initialized) {bindWorkspaceControls(); view.initialized = true;}
  return activated;
}
function draftSnapshot(s = {}) {
  return {
    configured: false, id: null, activity: 'idle', shouldPause: false,
    note: '新建任务工作区：请设置源视频根目录并应用，已有任务不受影响',
    source: '', output: '', scannedAt: null, scanProgress: {done: 0, total: 0},
    counts: {total: 0, pending: 0, running: 0, done: 0, failed: 0, interrupted: 0, probe_failed: 0, conflict: 0},
    sourceBytes: 0, outputBytes: 0, tasks: [], sessions: s.sessions || [],
    template: {videoCodec: '', scaleMode: 'none', percent: 100, crf: ''}
  };
}
function createDraftWorkspace() {
  if (typeof closeFileTemplate === 'function') closeFileTemplate();
  if (typeof closeCompare === 'function' && currentCompareTask) closeCompare();
  workspaceViews.drop(DRAFT_KEY);
  draftSession = true;
  draftSuffix = '_task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
  const {view} = mountWorkspace(DRAFT_KEY);
  view.sourceEdited = false;
  view.outputEdited = false;
  sourceEdited = false;
  outputEdited = false;
  $('source').value = '';
  $('output').value = '';
  setTemplateForm('tpl', draftSnapshot().template);
  model = draftSnapshot(serverSnapshot || {});
  renderSummary(model);
  renderTree(model);
  renderSessions(serverSnapshot || {sessions:[]});
  $('source').focus();
}
let model = null;
let busy = false;
let sourceEdited = false;
let outputEdited = false;
let closedDirs = new Set();
let openedFiles = new Set();
let collapsedAll = false;
let activeModalDir = '';
let lastProjectKey = '';
let toastTimer = null;
let draftSession = false;
let lastTemplateKey = '';
let currentEditTask = null;
let currentCompareTask = null;
const mapStatus = { pending: '待处理', running: '转码中', done: '已完成', failed: '失败', interrupted: '已中断', probe_failed: '探测失败', conflict: '目标冲突' };
function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 3700);
}
function fmtBytes(n) {
  if (n == null) return '—';
  let i = 0, v = n; const units = ['B','KiB','MiB','GiB','TiB'];
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 2 : 0)} ${units[i]}`;
}
function fmtDuration(n) {
  if (!n) return '未知'; const sec = Math.round(n); const h = Math.floor(sec / 3600); const m = Math.floor(sec % 3600 / 60);
  return `${h ? `${h}小时` : ''}${m}分${sec % 60}秒`;
}
function el(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = value;
  return element;
}
function setText(id, value) { $(id).textContent = value; }
function defaultOut(src) {
  const normalized = src.replace(/[\\/]+$/, '');
  return normalized ? normalized + '_h265_720p' : '';
}
async function request(url, data) {
  const response = await fetch(url, data === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function action(endpoint, body = {}) {
  try { await request(endpoint, body); await refresh(); return true; }
  catch (e) { toast(e.message); return false; }
}
function enableControls(s) {
  const idle = s.activity === 'idle'; const trans = s.activity === 'transcoding';
  for (const id of ['configure','scan']) $(id).disabled = !idle && !draftSession;
  for (const id of ['retry','verify','verify-deep']) $(id).disabled = !idle || draftSession;
  $('new-task').disabled = false;
  $('save-template').disabled = !idle || !s.configured || draftSession;
  $('start').disabled = !idle || !s.scannedAt || draftSession;
  $('pause').disabled = !trans || s.shouldPause || draftSession;
  $('stop').disabled = !trans || draftSession;
  $('browse-source').disabled = !idle && !draftSession;
  $('source').disabled = !idle && !draftSession;
  $('output').disabled = !idle && !draftSession;
  $('default-output').disabled = !idle && !draftSession;
}
function renderSummary(s) {
  const c = s.counts;
  setText('m-total', c.total);
  setText('m-done', c.done);
  setText('m-running', c.running || 0);
  setText('m-pending', (c.pending || 0) + (c.interrupted || 0));
  setText('m-failed', (c.failed || 0) + (c.probe_failed || 0) + (c.conflict || 0));
  const percent = c.total ? c.done / c.total * 100 : 0;
  setText('m-percent', `${percent.toFixed(1)}% 完成`);
  const active = s.tasks.find(x => x.status === 'running');
  const weighted = c.total ? s.tasks.reduce((n, t) => n + (t.status === 'done' ? 1 : t.status === 'running' ? (t.progress || 0) / 100 : 0), 0) / c.total * 100 : 0;
  $('overall-progress').style.width = weighted.toFixed(2) + '%';
  setText('overall-progress-text', active ? `当前转码：${active.relative} · ${(active.progress || 0).toFixed(1)}% · ${active.speed || '计算速度中'}` : `全部视频进度：${percent.toFixed(1)}%`);
  const saving = s.outputBytes && s.sourceBytes ? ` · 已完成文件压缩率 ${Math.round((1-s.outputBytes / Math.max(1, s.tasks.filter(t => t.status === 'done').reduce((n,t) => n+t.bytes,0))) *100)}%` : '';
  setText('overall-size', `${fmtBytes(s.sourceBytes)} 源数据${saving}`);
  setText('status-note', s.note || '就绪');
  const exports = { 'export-cmd': '/api/export/commands', 'export-csv': '/api/export/report.csv',
    'export-json': '/api/export/report.json' };
  for (const [id, url] of Object.entries(exports)) {
    const link = $(id);
    if (s.configured && !draftSession) {
      link.href = url; link.removeAttribute('aria-disabled'); link.tabIndex = 0;
    } else {
      link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); link.tabIndex = -1;
    }
  }
  setText('last-scan', s.activity === 'scanning' ? `扫描中 ${s.scanProgress.done}/${s.scanProgress.total}` : s.scannedAt ? `上次扫描：${new Date(s.scannedAt).toLocaleString()}` : '尚未扫描');
  const badge = $('activity-badge');
  badge.className = 'activity' + (s.activity === 'transcoding' ? ' running' : '');
  badge.textContent = ({ idle: '空闲', scanning: 'ffprobe 扫描', transcoding: '正在转码', preparing: '检查 FFmpeg', verifying: '正在验收' })[s.activity] || s.activity;
  setText('setup-msg', draftSession ? '正在创建新任务：应用目录后独立保存，旧任务不受影响' : s.configured ? `任务状态目录：${s.output}` : '尚未配置任务');
  enableControls(s);
}
function shouldShow(t, filter) {
  if (filter === 'all') return true;
  if (filter === 'pending') return ['pending','interrupted','running'].includes(t.status);
  if (filter === 'failed') return ['failed','conflict'].includes(t.status);
  return t.status === filter;
}
function buildTree(tasks) {
  const root = { name: '', id: '', dirs: new Map(), files: [] };
  for (const t of tasks) {
    const parts = t.relative.split('/'); let node = root;
    for (const part of parts.slice(0,-1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, id: node.id ? node.id + '/' + part : part, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(t);
  }
  return root;
}
function fullStats(tasks) {
  const root = buildTree(tasks);
  const stats = new Map();
  VideoTreeStats.summarize(root, stats);
  return stats;
}
function nameBox(icon, text, isFolder) {
  const wrap = el('span');
  wrap.append(el('span', 'arrow', isFolder ? (closedDirs.has(text) ? '▸' : '▾') : ''));
  wrap.append(el('span', isFolder ? 'folder-symbol' : 'file-symbol', isFolder ? '▰' : '▣'));
  wrap.append(el('span', isFolder ? 'folder-label' : 'file-label', icon));
  return wrap;
}
function renderFolder(parent, node, depth) {
  const div = el('div', 'folder');
  const hdr = el('button', 'folder-head'); hdr.type = 'button'; hdr.style.paddingLeft = (12+depth*18)+'px';
  const left = nameBox(node.name, node.id, true);
  const stats = node.stats || {total:0, done:0, problems:0, running:0};
  left.append(el('span', 'folder-count', `${stats.total} 个`));
  hdr.append(left, el('span', 'folder-stats', `已完成 ${stats.done} · 异常/中断 ${stats.problems} · 转码中 ${stats.running} · 总计 ${stats.total}`));
  const closed = closedDirs.has(node.id);
  hdr.firstChild.firstChild.textContent = closed ? '▸' : '▾';
  hdr.addEventListener('click', () => { if (closedDirs.has(node.id)) closedDirs.delete(node.id); else closedDirs.add(node.id); renderTree(model); });
  div.append(hdr);
  if (!closed) renderNode(div, node, depth+1);
  parent.append(div);
}
function detailRow(title, content) {
  const div = el('div'); div.append(el('b', '', title + '：'), document.createTextNode(content || '—')); return div;
}
function renderFile(parent, t, depth) {
  const row = el('div', 'file');
  const hdr = el('button', 'file-head'); hdr.type='button'; hdr.style.paddingLeft=(12+depth*18)+'px';
  const left = nameBox(t.relative.split('/').pop(), null, false);
  left.firstChild.textContent = openedFiles.has(t.id) ? '▾' : '▸';
  if (t.override) left.append(el('span','override-tag','独立参数'));
  hdr.append(left);
  hdr.append(el('span', 'resolution', t.width ? `${t.width}×${t.height} → ${t.targetWidth}×${t.targetHeight}` : '探测失败'));
  const badgeSlot = el('span'); badgeSlot.append(el('span', 'status-pill '+t.status, mapStatus[t.status] || t.status)); hdr.append(badgeSlot);
  const p = el('span', 'file-progress', t.status === 'done' ? '100%' : t.status === 'running' ? `${(t.progress || 0).toFixed(1)}%` : '—');
  const line = el('div','mini-progress'); const fill=el('span'); fill.style.width=(t.status === 'done' ? 100 : t.progress || 0)+'%'; line.append(fill); p.append(line); hdr.append(p);
  hdr.addEventListener('click', () => {
    if (openedFiles.has(t.id)) openedFiles.delete(t.id);
    else {openedFiles.add(t.id); logScrollStates.delete(workspaceViews.activeKey + ':' + t.id);}
    renderTree(model);
  });
  row.append(hdr);
  if (openedFiles.has(t.id)) {
    const info = el('div','file-details');
    const meta = el('div','detail-meta');
    meta.append(detailRow('相对路径', t.relative), detailRow('原始视频', `${t.width || '?'}×${t.height || '?'} · ${t.sourceCodec || '?'} · ${fmtBytes(t.bytes)}`),
      detailRow('孪生输出', t.output), detailRow('目标尺寸 / 音频', `${t.targetWidth || '?'}×${t.targetHeight || '?'} · ${t.audioCodec ? t.audioCodec + ' copy' : '无音频'}`),
      detailRow('源视频时长', fmtDuration(t.duration)), detailRow('任务', `${mapStatus[t.status] || t.status} · 重试次数 ${t.attempts || 0} · ${t.speed || ''}`));
    if (t.status === 'done') meta.append(detailRow('完成输出', `${fmtBytes(t.outputBytes)} · 最近验收 ${t.verifiedAt ? new Date(t.verifiedAt).toLocaleString() : '未记录'}`));
    info.append(meta);
    const tools = el('div','file-tools');
    const editBtn = el('button','secondary','单独设置转码参数');
    editBtn.type='button'; editBtn.disabled = model.activity !== 'idle';
    editBtn.addEventListener('click', () => openFileTemplate(t)); tools.append(editBtn);
    if (t.status === 'done') {
      const compare = el('button','secondary','原视频 / 结果视频对比');
      compare.type='button'; compare.addEventListener('click', () => openCompare(t)); tools.append(compare);
    }
    info.append(tools);
    if (t.command) {
      const title = el('div','cmd-title'); title.append(el('b','', 'FFmpeg 实际执行命令'));
      const copy = el('button','secondary','复制命令'); copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(t.command); toast('命令已复制'); } catch { toast('复制失败，请手动选择命令'); } });
      title.append(copy); info.append(title); info.append(el('pre','command-code',t.command));
    }
    if (t.error) info.append(el('div','err',t.error));
    if (t.log) {
      info.append(el('div','cmd-title','最近一次 FFmpeg 日志（仅保留末尾片段）'));
      const logView = el('pre','log-code',t.log);
      logView.dataset.taskId = t.id;
      logView.tabIndex = 0;
      info.append(logView);
    }
    row.append(info);
  }
  parent.append(row);
  const logView = row.querySelector('.log-code');
  if (logView) {
    const remembered = logScrollStates.get(workspaceViews.activeKey + ':' + t.id);
    // The first opening follows the latest line; a user reading older lines
    // keeps that position across periodic tree rerenders.
    logView.scrollTop = remembered && !remembered.follow ? remembered.top : logView.scrollHeight;
  }
}
function renderNode(parent,node,depth) {
  const dirs = [...node.dirs.values()].sort((a,b) => a.name.localeCompare(b.name,'zh-Hans-CN'));
  for (const dir of dirs) renderFolder(parent,dir,depth);
  for (const file of node.files.sort((a,b)=>a.relative.localeCompare(b.relative,'zh-Hans-CN'))) renderFile(parent,file,depth);
}
function renderTree(s) {
  const container=$('tree');
  for (const log of container.querySelectorAll('.log-code')) {
    const follow = log.scrollHeight - log.clientHeight - log.scrollTop <= 24;
    logScrollStates.set(workspaceViews.activeKey + ':' + log.dataset.taskId,
      {top: log.scrollTop, follow});
  }
  container.replaceChildren();
  const filtered = s.tasks.filter(t => shouldShow(t,$('filter').value));
  if (!filtered.length) { container.append(el('div','empty', s.activity === 'scanning' ? `正在探测文件 ${s.scanProgress.done}/${s.scanProgress.total}…` : '没有符合当前筛选条件的视频')); return; }
  const tree=buildTree(filtered); const statMap = fullStats(s.tasks);
  const attach = node => {node.stats = statMap.get(node.id); for (const child of node.dirs.values()) attach(child);};
  attach(tree); renderNode(container,tree,0);
}
let refreshBusy = false;
let refreshPending = false;
async function refresh() {
  if (refreshBusy) {refreshPending = true; return;}
  refreshBusy = true;
  try {
    const snapshot = await request('/api/status');
    serverSnapshot = snapshot;
    setText('connection','已连接');
    const key = draftSession ? DRAFT_KEY : (snapshot.id || '__empty__');
    const {created} = mountWorkspace(key);
    if (!draftSession && created) {
      $('source').value = snapshot.source;
      $('output').value = snapshot.output || defaultOut(snapshot.source);
      sourceEdited = !!snapshot.source;
      outputEdited = !!snapshot.output;
      setTemplateForm('tpl',snapshot.template);
    }
    model = draftSession ? draftSnapshot(snapshot) : snapshot;
    renderSummary(model);
    renderSessions(snapshot);
    renderTree(model);
  } catch (e) {setText('connection','连接断开');}
  finally {
    refreshBusy = false;
    if (refreshPending) {refreshPending = false; void refresh();}
  }
}
function outputSuggestion(source) {
  const base=defaultOut(source);
  return base && draftSession ? base + draftSuffix : base;
}
function updateOutputFromSource() { if (!outputEdited) $('output').value=outputSuggestion($('source').value.trim()); }
async function applyProject(endpoint) {
  const source=$('source').value.trim(), output=$('output').value.trim();
  try {
    await request(endpoint,{source,output});
    draftSession = false;
    workspaceViews.drop(DRAFT_KEY);
    await refresh();
  } catch (e) {toast(e.message);}
}
function bindWorkspaceControls() {
  $('source').addEventListener('input', () => {sourceEdited=true; updateOutputFromSource();});
  $('output').addEventListener('input', () => {outputEdited=true;});
  $('default-output').addEventListener('click', () => {$('output').value=outputSuggestion($('source').value.trim()); outputEdited=false;});
  $('configure').addEventListener('click', () => applyProject('/api/config'));
  $('scan').addEventListener('click', () => applyProject('/api/scan'));
  $('start').addEventListener('click', () => action('/api/start'));
  $('pause').addEventListener('click', () => action('/api/pause'));
  $('stop').addEventListener('click', () => {
    if (confirm('立即终止当前视频转码？未完成文件保留为 .partial，重试时会删除并从头转码。')) action('/api/stop');
  });
  $('retry').addEventListener('click', () => action('/api/retry'));
  $('verify').addEventListener('click', () => action('/api/verify', {deep:false}));
  $('verify-deep').addEventListener('click', () => {
    if (confirm('完整解码验收需要读取所有已完成视频，可能比较耗时。继续？')) action('/api/verify',{deep:true});
  });
  $('filter').addEventListener('change', () => {if (model) renderTree(model);});
  $('expand').addEventListener('click', () => {closedDirs.clear();if(model)renderTree(model);});
  $('collapse').addEventListener('click', () => {
    if (!model) return;
    closedDirs.clear();
    const visit = node => {for (const child of node.dirs.values()) {closedDirs.add(child.id);visit(child);}};
    visit(buildTree(model.tasks));renderTree(model);
  });
  $('browse-source').addEventListener('click', () => {
    $('dialog').classList.remove('hidden');openDir($('source').value.trim() || undefined);
  });
  for (const id of ['tpl-codec','tpl-scale']) $(id).addEventListener('change', () => updateTemplateControls('tpl'));
  $('save-template').addEventListener('click', async () => {
    try {await request('/api/template',getTemplateForm('tpl'));toast('批量模板已保存');await refresh();}
    catch(e){toast(e.message);}
  });
}
async function openDir(dir) {
  try {
    const result = await request('/api/directories'+(dir?'?path='+encodeURIComponent(dir):''));
    activeModalDir=result.current;
    setText('dir-current',result.current || '选择磁盘');
    $('dir-parent').disabled=!result.parent;
    $('dir-parent').onclick=() => openDir(result.parent);
    const list=$('dir-list'); list.replaceChildren();
    if (!result.dirs.length) list.append(el('div','empty','没有可进入的子目录'));
    for (const item of result.dirs) {
      const row=el('button','dir-row'); row.type='button'; row.append(el('span','', '▰'),document.createTextNode(item.name));
      row.onclick=()=>openDir(item.full); list.append(row);
    }
  } catch (e) { toast(e.message); }
}
$('browse-source').addEventListener('click',() => { $('dialog').classList.remove('hidden'); openDir($('source').value.trim() || undefined); });
$('close-dialog').addEventListener('click',()=>$('dialog').classList.add('hidden'));
$('dialog').addEventListener('click',e=>{ if(e.target===$('dialog')) $('dialog').classList.add('hidden'); });
$('dir-select').addEventListener('click',()=>{
  if (!activeModalDir) return toast('请选择目录');
  $('source').value=activeModalDir;
  $('output').value=outputSuggestion(activeModalDir);
  outputEdited=false;
  $('dialog').classList.add('hidden');
});
refresh(); setInterval(refresh, 1500);
