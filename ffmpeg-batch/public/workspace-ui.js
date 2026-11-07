'use strict';
function setTemplateForm(prefix, template = {}) {
  const codec = template.videoCodec || '';
  const chooser = $(prefix+'-codec');
  chooser.value = ['', 'libx265', 'libx264', 'libsvtav1', 'hevc_nvenc', 'h264_nvenc'].includes(codec) ? codec : 'custom';
  $(prefix+'-custom').value = chooser.value === 'custom' ? codec : '';
  $(prefix+'-scale').value = template.scaleMode || 'none';
  $(prefix+'-percent').value = template.percent ?? 100;
  $(prefix+'-crf').value = template.crf ?? '';
  $(prefix+'-fraction').value = template.fraction ?? '2/3';
  $(prefix+'-short-edge').value = template.shortEdge ?? 720;
  if ($(prefix+'-width')) $(prefix+'-width').value = template.width ?? '';
  if ($(prefix+'-height')) $(prefix+'-height').value = template.height ?? '';
  updateTemplateControls(prefix);
}
function updateTemplateControls(prefix) {
  $(prefix+'-custom').classList.toggle('hidden', $(prefix+'-codec').value !== 'custom');
  const mode = $(prefix+'-scale').value;
  $(prefix+'-percent-wrap').classList.toggle('hidden', mode !== 'percent');
  $(prefix+'-fraction-wrap').classList.toggle('hidden', mode !== 'fraction');
  $(prefix+'-short-edge-wrap').classList.toggle('hidden', mode !== 'shortEdge');
  if ($(prefix+'-dimensions')) $(prefix+'-dimensions').classList.toggle('hidden', mode !== 'exact');
}
function getTemplateForm(prefix) {
  return {
    videoCodec: $(prefix+'-codec').value === 'custom' ? $(prefix+'-custom').value.trim() : $(prefix+'-codec').value,
    scaleMode: $(prefix+'-scale').value,
    percent: Number($(prefix+'-percent').value),
    crf: $(prefix+'-crf').value.trim(),
    ...($(prefix+'-scale').value === 'fraction' ? {fraction:$(prefix+'-fraction').value.trim()} : {}),
    ...($(prefix+'-scale').value === 'shortEdge' ? {shortEdge:Number($(prefix+'-short-edge').value)} : {}),
    ...($(prefix+'-scale').value === 'exact' ? {width:Number($(prefix+'-width').value),height:Number($(prefix+'-height').value)} : {})
  };
}
function renderSessions(s) {
  const container = $('task-list'); container.replaceChildren();
  if (draftSession) {
    const current = el('div','session session-draft selected');
    current.append(el('strong','session-title','新建任务 · 独立工作区'),
      el('span','session-meta','尚未应用目录，所有统计与结果均为空'));
    container.append(current);
  }
  if (!s.sessions.length) {
    if (!draftSession) container.append(el('div','sidebar-empty','尚无任务，先创建第一个任务'));
    return;
  }
  for (const item of s.sessions) {
    const button = el('button','session' + (s.id === item.id && !draftSession ? ' selected' : ''));
    button.type='button'; // All sessions remain selectable while other workers run.
    button.append(el('strong','session-title',item.source.split(/[\\/]/).filter(Boolean).pop() || item.source));
    button.append(el('span','session-date',new Date(item.createdAt).toLocaleString()));
    button.append(el('span','session-meta',`完成 ${item.done}/${item.total} · 异常 ${item.failed} · 转码中 ${item.running || 0}`));
    if (item.activity !== 'idle') button.append(el('span','session-working',item.activity === 'transcoding' ? '正在转码' : '正在处理'));
    button.title = `${item.source}\n${item.output}`;
    button.addEventListener('click', async () => {
      if (s.id === item.id && !draftSession) return;
      try {
        await request('/api/sessions/select',{id:item.id});
        draftSession = false;
        workspaceViews.drop(DRAFT_KEY);
        if(currentEditTask)closeFileTemplate();
        if(currentCompareTask)closeCompare();
        await refresh();
      } catch (e) {toast(e.message);}
    });
    container.append(button);
  }
}
function openFileTemplate(t) {
  currentEditTask = t.id;
  $('item-inherit').checked = !t.override;
  setTemplateForm('item', t.override || t.template || model.template);
  $('item-title').textContent = t.relative;
  $('file-template-dialog').classList.remove('hidden');
  $('item-fields').disabled = $('item-inherit').checked;
}
function closeFileTemplate() { currentEditTask = null; $('file-template-dialog').classList.add('hidden'); }
const compareController = DualVideoSync.createController({
  source: $('compare-source'), output: $('compare-output'),
  toggle: $('compare-play-toggle'), state: $('compare-sync-state'), onError: toast
});
function openCompare(t) {
  if (currentCompareTask) closeCompare();
  currentCompareTask = t.id;
  $('compare-title').textContent = t.relative;
  for (const side of ['source','output']) {
    const video = $('compare-'+side);
    video.src = '/api/video?side=' + side + '&session=' + encodeURIComponent(model.id) + '&id=' + encodeURIComponent(t.id);
    video.load();
  }
  $('compare-dialog').classList.remove('hidden');
  compareController.activate();
}
function closeCompare() {
  compareController.deactivate();
  for (const side of ['source','output']) {
    const video=$('compare-'+side); video.pause(); video.removeAttribute('src'); video.load();
  }
  currentCompareTask = null;
  $('compare-dialog').classList.add('hidden');
}
for (const id of ['item-codec','item-scale']) $(id).addEventListener('change',()=>updateTemplateControls('item'));
$('new-task').addEventListener('click', createDraftWorkspace);
for (const [id, seconds] of [['compare-back-8',-8],['compare-back-2',-2],
  ['compare-next-2',2],['compare-next-8',8]]) {
  $(id).addEventListener('click',()=>compareController.seekBy(seconds));
}
$('compare-play-toggle').addEventListener('click',()=>compareController.toggleBoth());
document.addEventListener('keydown',event=>compareController.handleKey(event),true);
$('item-inherit').addEventListener('change', () => $('item-fields').disabled = $('item-inherit').checked);
$('save-item-template').addEventListener('click', async () => {
  try {
    await request('/api/template/item',{id:currentEditTask,override:$('item-inherit').checked ? null : getTemplateForm('item')});
    closeFileTemplate(); await refresh(); toast('单文件模板已保存');
  } catch (e) {toast(e.message);}
});
$('close-item-template').addEventListener('click', closeFileTemplate);
$('close-compare').addEventListener('click', closeCompare);
for (const pair of [['file-template-dialog',closeFileTemplate],['compare-dialog',closeCompare]]) {
  $(pair[0]).addEventListener('click', e => {if(e.target === $(pair[0])) pair[1]();});
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(currentCompareTask)closeCompare();if(currentEditTask)closeFileTemplate();}});
const themeChoice = $('theme-select');
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let savedTheme = 'light';
try {savedTheme = localStorage.getItem('ffmpeg-batch-theme') || 'light';} catch {}
function applyTheme(value) {
  document.documentElement.dataset.theme = value === 'system' ? (themeMedia.matches ? 'dark' : 'light') : value;
}
themeChoice.value = ['light','dark','system'].includes(savedTheme) ? savedTheme : 'light';
applyTheme(themeChoice.value);
themeChoice.addEventListener('change', () => {
  applyTheme(themeChoice.value);
  try {localStorage.setItem('ffmpeg-batch-theme',themeChoice.value);} catch {}
});
if (themeMedia.addEventListener) themeMedia.addEventListener('change', () => applyTheme(themeChoice.value));
