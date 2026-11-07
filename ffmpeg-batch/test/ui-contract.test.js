'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const get=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('界面关键控件和脚本入口齐备',()=>{
  const html=get('public/index.html');
  for(const id of ['theme-select','task-list','new-task','save-template','tpl-codec','tpl-scale','tpl-crf','file-template-dialog','item-inherit','item-width','item-height','compare-dialog','compare-source','compare-output']) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.match(html,/<script src="\/tree-stats.js"/);
  assert.match(html,/<script src="\/app.js"/);
  assert.match(html,/<script src="\/workspace-ui.js"/);
});
test('目录汇总、单文件编辑及自动应用目录存在',()=>{
  const app=get('public/app.js');
  assert.match(app,/VideoTreeStats\.summarize/);
  assert.match(app,/openFileTemplate\(t\)/);
  assert.match(app,/openCompare\(t\)/);
  assert.match(app,/action\('\/api\/scan', \{source:/);
});
test('宽窄视口播放器不会超过容器边界',()=>{
  const css=get('public/workspace.css');
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:800px\)/);
  assert.match(css,/\.compare-video video\{[^}]*max-width:100%/);
  assert.match(css,/max-height:max\(80px,calc\(\(100dvh - 230px\)\/2\)\)/);
});
