'use strict';
function setTemplateForm(prefix, template = {}) {
  const codec = template.videoCodec || '';
  const chooser = $(prefix+'-codec');
  chooser.value = ['', 'copy', 'libx265', 'libx264', 'libsvtav1', 'hevc_nvenc', 'h264_nvenc'].includes(codec) ? codec : 'custom';
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
  const copy = $(prefix+'-codec').value === 'copy';
  if (copy) {$(prefix+'-scale').value = 'none';$(prefix+'-crf').value = '';}
  $(prefix+'-scale').disabled = copy;
  $(prefix+'-crf').disabled = copy;
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
function renderBatchTemplateLibrary(s, force=false) {
  const picker=$('tpl-template-select');
  const entries=s.templates?.length ? s.templates : [{id:'default',name:'默认模板',template:s.template}];
  const selected=entries.some(t=>t.id===picker.value)?picker.value:(s.globalTemplateId||entries[0].id);
  const signature=JSON.stringify(entries.map(t=>[t.id,t.name,t.id===s.globalTemplateId]));
  if(picker.dataset.list!==signature){
    picker.replaceChildren();
    for(const t of entries){
      const option=el('option','',t.name+(t.id===s.globalTemplateId?'（全局）':'（局部）'));
      option.value=t.id;picker.append(option);
    }
    picker.dataset.list=signature;
  }
  picker.value=selected;
  const entry=entries.find(t=>t.id===selected);
  const locked=draftSession||!s.configured||s.activity!=='idle';
  $('tpl-template-select').disabled=locked;
  $('tpl-name').disabled=locked;
  $('tpl-new').disabled=locked;
  $('tpl-global').disabled=locked||selected===s.globalTemplateId;
  $('tpl-delete').disabled=locked||selected===s.globalTemplateId;
  $('tpl-scope-hint').textContent=selected===s.globalTemplateId
    ? '当前全局模板：仅影响采用全局参数的视频'
    : '当前局部模板：仅影响明确引用该模板的视频';
  if(force||picker.dataset.loadedId!==selected) {
    $('tpl-name').value=entry.name;
    setTemplateForm('tpl',entry.template);
    picker.dataset.loadedId=selected;
  }
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
    const wrapper=el('div','session-slot');
    wrapper.append(button);
    const remove=el('button','danger session-delete','删除');
    remove.type='button';remove.disabled=item.activity!=='idle';
    remove.title='仅删除任务记录和状态文件，保留所有源视频及转码结果';
    remove.addEventListener('click',async()=>{
      if(!confirm('确定删除该任务？将移除历史任务记录和状态文件，但不会删除源视频、转码结果或输出目录。'))return;
      try{
        await request('/api/sessions/delete',{id:item.id});
        workspaceViews.drop(item.id);
        if(currentEditTask)closeFileTemplate();
        if(currentCompareTask)closeCompare();
        await refresh();toast('任务记录已删除，视频文件已保留');
      }catch(e){toast(e.message);}
    });
    wrapper.append(remove);container.append(wrapper);
  }
}
function updateItemScope(){
  const local=$('item-scope-local').checked;
  $('item-local-template').disabled=!local;
  $('item-fields').disabled=!$('item-scope-independent').checked;
}
function openFileTemplate(t) {
  currentEditTask = t.id;
  const selected=t.templateScope|| (t.override?'independent':'global');
  $('item-scope-'+selected).checked=true;
  const picker=$('item-local-template');
  picker.replaceChildren(el('option','','请选择模板'));
  picker.firstChild.value='';
  for(const entry of model.templates||[]){
    if(entry.id===model.globalTemplateId)continue;
    const option=el('option','',entry.name);option.value=entry.id;picker.append(option);
  }
  picker.value=selected==='local'?(t.localTemplateId||''):'';
  setTemplateForm('item', t.override || t.template || model.template);
  $('item-title').textContent = t.relative;
  $('file-template-dialog').classList.remove('hidden');
  updateItemScope();
}
function closeFileTemplate() { currentEditTask = null; $('file-template-dialog').classList.add('hidden'); }
const compareController = DualVideoSync.createController({
  source: $('compare-source'), output: $('compare-output'),
  toggle: $('compare-play-toggle'), state: $('compare-sync-state'), onError: toast
});
function compareCandidates(){
  const done=model?.tasks?.filter(t=>t.status==='done')||[];
  const filtered=done.filter(t=>shouldShow(t,$('filter').value));
  const candidates=filtered.some(t=>t.id===currentCompareTask)?filtered:done;
  return candidates.sort((a,b)=>a.relative.localeCompare(b.relative,'zh-Hans-CN'));
}
function updateCompareNav(){
  if(!currentCompareTask)return;
  const candidates=compareCandidates();
  const index=candidates.findIndex(t=>t.id===currentCompareTask);
  $('compare-previous').disabled=index<=0;
  $('compare-following').disabled=index<0||index>=candidates.length-1;
}
function stepCompare(direction){
  const candidates=compareCandidates();
  const index=candidates.findIndex(t=>t.id===currentCompareTask);
  const next=candidates[index+direction];
  if(next)openCompare(next);
}
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
  updateCompareNav();
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
for(const id of ['item-scope-global','item-scope-local','item-scope-independent'])
  $(id).addEventListener('change',updateItemScope);
$('compare-previous').addEventListener('click',()=>stepCompare(-1));
$('compare-following').addEventListener('click',()=>stepCompare(1));
$('save-item-template').addEventListener('click', async () => {
  try {
    const mode=document.querySelector('input[name="item-scope"]:checked')?.value;
    const selection=mode==='local'?{mode,templateId:$('item-local-template').value}:
      mode==='independent'?{mode,template:getTemplateForm('item')}:{mode:'global'};
    if(mode==='local'&&!selection.templateId)throw new Error('请选择局部作用域模板');
    await request('/api/template/item',{id:currentEditTask,selection});
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
