'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const get=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('界面关键控件和脚本入口齐备',()=>{
  const html=get('public/index.html');
  for(const id of ['theme-select','task-list','new-task','save-template','tpl-codec','tpl-scale','tpl-crf','file-template-dialog','tpl-template-select','tpl-name','tpl-new','tpl-global','tpl-delete','item-scope-global','item-scope-local','item-scope-independent','item-local-template','filter-keyword','filter-size-min','filter-size-max','filter-resolution','compare-previous','compare-following','item-width','item-height','compare-dialog','compare-source','compare-output']) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.match(html,/<script src="\/tree-stats.js"/);
  assert.match(html,/<script src="\/app.js"/);
  assert.match(html,/<script src="\/file-filters.js"/);
  assert.match(html,/<script src="\/workspace-ui.js"/);
});
test('目录汇总、单文件编辑及自动应用目录存在',()=>{
  const app=get('public/app.js');
  assert.match(app,/VideoTreeStats\.summarize/);
  assert.match(app,/openFileTemplate\(t\)/);
  assert.match(app,/openCompare\(t\)/);
  assert.match(app,/applyProject\('\/api\/scan'\)/);
});
test('宽窄视口播放器不会超过容器边界',()=>{
  const css=get('public/workspace.css');
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:800px\)/);
  assert.match(css,/\.compare-video video\{[^}]*max-width:100%/);
  assert.match(css,/max-height:max\(80px,calc\(\(100dvh - 230px\)\/2\)\)/);
});

test('Q1-B：两种缩放表单、独立参数标识及队列转码中统计',()=>{
  const html=get('public/index.html');
  for(const id of ['tpl-fraction','tpl-fraction-wrap','tpl-short-edge','tpl-short-edge-wrap','item-fraction','item-short-edge','m-running']) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  const done=html.indexOf('id="m-done"'),running=html.indexOf('id="m-running"'),pending=html.indexOf('id="m-pending"');
  assert.ok(done>=0&&running>done&&pending>running,'转码中统计必须紧邻转码完成右侧');
  assert.match(html,/720\/1080 或 2\/3/);
  const app=get('public/app.js');
  assert.match(app,/override-tag.*独立参数/);
  assert.match(app,/setText\('m-running'/);
  const workspace=get('public/workspace-ui.js');
  assert.match(workspace,/\$\('new-task'\)\.addEventListener/);
  assert.doesNotMatch(workspace,/button\.disabled\s*=\s*s\.activity/);
  assert.match(workspace,/\$\(prefix\+'-fraction'\)/);
  assert.match(workspace,/\$\(prefix\+'-short-edge'\)/);
  const css=get('public/workspace.css');
  assert.match(css,/\.metrics\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
});

test('Q1-C：独立工作区模板真实克隆，旧任务状态不混入新建草稿',()=>{
  const html=get('public/index.html');
  const first=html.indexOf('<template id="task-workspace-template">');
  const last=html.indexOf('</template>',first);
  const section=html.slice(first,last);
  assert.ok(first>0&&last>first);
  assert.equal((section.match(/<section class="panel/g)||[]).length,5,'01～04 和报告应整套克隆');
  for(const className of ['setup','template-panel','overview','files','export'])
    assert.match(section,new RegExp('class="panel '+className+'"'));
  assert.ok(html.indexOf('id="workspace-host"')>last,'工作区只能挂载到模板之后的宿主节点');
  for(const script of ['workspace-dom.js','compare-sync.js'])assert.match(html,new RegExp('src="/'+script.replace('.','\\.')+'"'));
  const app=get('public/app.js'),ui=get('public/workspace-ui.js');
  assert.match(app,/workspaceViews\.activate\(key\)/);
  assert.match(app,/workspaceViews\.drop\(DRAFT_KEY\)/);
  assert.match(app,/function draftSnapshot/);
  assert.match(app,/function bindWorkspaceControls/);
  assert.match(ui,/createDraftWorkspace/);
  assert.doesNotMatch(ui,/\$\('source'\)\.value\s*=\s*source/);
  assert.match(app,/link\.removeAttribute\('href'\)/,'新草稿不能导出旧任务的结果');
});
test('Q1-C：日志滚动末行、五个同步按钮和方向键双击规则',()=>{
  const html=get('public/index.html');
  for(const id of ['compare-back-8','compare-back-2','compare-play-toggle','compare-next-2','compare-next-8'])
    assert.match(html,new RegExp('id="'+id+'"'));
  const footer=html.slice(html.indexOf('class="compare-footer"'));
  for(const id of ['compare-back-8','compare-back-2','compare-play-toggle','compare-next-2','compare-next-8'])
    assert.ok(footer.includes(id));
  const app=get('public/app.js'),ui=get('public/workspace-ui.js'),sync=get('public/compare-sync.js');
  assert.match(app,/log\.scrollTop\s*=/);
  assert.match(app,/logScrollStates/);
  assert.match(ui,/compareController\.activate\(\)/);
  assert.match(ui,/compareController\.deactivate\(\)/);
  assert.match(sync,/DOUBLE_TAP_MS=280/);
  assert.match(sync,/seekBy\(direction\*8\)/);
  assert.match(sync,/seekBy\(pending\.direction\*2\)/);
});


test('Q1-H：可观看性验收入口、遮罩控制、报告及脚本加载顺序齐备',()=>{
  const html=get('public/index.html');
  for(const id of ['verify-watchability','watchability-dialog','watchability-pause','watchability-stop',
    'watchability-progress-fill','watchability-report','watchability-report-summary','watchability-report-body',
    'watchability-export','watchability-report-close']) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.ok(html.indexOf('watchability-audit.js')<html.indexOf('/app.js'),'画面比较核心必须先于应用脚本加载');
  assert.ok(html.indexOf('watchability-audit-ui.js')>html.indexOf('/workspace-ui.js'),'验收控制器必须在双视频组件后加载');
  const app=get('public/app.js');
  assert.match(app,/verify-watchability/);
  const audit=get('public/watchability-audit-ui.js');
  assert.match(audit,/filter\(task => task\.status === 'done'\)/);
  assert.match(audit,/openCompare\(task\)/);
  assert.match(audit,/points: 10/);
  assert.match(audit,/playMs: 1200/);
  assert.match(audit,/watchabilityRun\.pause/);
  assert.match(audit,/watchabilityRun\.stop/);
  assert.match(audit,/WatchabilityAudit\.createVideoComparator/);
  const css=get('public/workspace.css');
  assert.match(css,/\.watchability-overlay\{z-index:40\}/);
  const launcher=get('tool/video-compare-audit-visual.js');
  assert.match(launcher,/verify-watchability/);
  assert.doesNotMatch(launcher,/getElementById\('(start|stop|retry|verify|verify-deep|scan|configure|new-task|save-template|delete|tpl-new)'/);
});
