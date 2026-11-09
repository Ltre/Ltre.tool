'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {SessionWorker,Manager}=require('../server');
const workflow=require('../workflow');
const filters=require('../public/file-filters');

async function fixture(t,prefix){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),output=path.join(root,'source_output');
  await fsp.mkdir(source);
  const worker=new SessionWorker({isolated:true});
  worker.configure({source,output});
  return {root,source,output,worker};
}
function video(worker,id){
  const input=path.join(worker.project.source,id+'.mp4');
  const output=path.join(worker.project.output,id+'.mp4');
  const template={...workflow.EMPTY};
  return {id,relative:id+'.mp4',input,output,temporary:output.replace(/\.mp4$/,'.partial.mp4'),
    width:320,height:180,bytes:1000,mtimeMs:1,targetWidth:320,targetHeight:180,
    sourceCodec:'h264',audioCodec:null,duration:2,status:'pending',progress:0,override:null,
    template,templateKey:JSON.stringify(template)};
}

test('Q1-F：copy 真正生成视频流复制命令，禁止缩放与 CRF',()=>{
  const template=workflow.normalizeTemplate({videoCodec:'copy',scaleMode:'none'});
  const task={input:'in.mp4',temporary:'out.partial.mp4',width:1920,height:1080,
    targetWidth:1920,targetHeight:1080,sourceCodec:'h264',template};
  const args=workflow.commandArgs(task);
  assert.deepEqual(args,['-i','in.mp4','-c:v','copy','-movflags','+faststart','-c:a','copy','out.partial.mp4']);
  assert.equal(workflow.expectedCodec(task),'h264');
  assert.throws(()=>workflow.normalizeTemplate({videoCodec:'copy',scaleMode:'shortEdge',shortEdge:720}),/复制/);
  assert.throws(()=>workflow.normalizeTemplate({videoCodec:'copy',scaleMode:'none',crf:25}),/CRF/);
});

test('Q1-F：旧项目和旧独立模板在升级后保留参数归属',async t=>{
  const {source,output,worker}=await fixture(t,'q1f-legacy-');
  const own=video(worker,'own');
  own.override=workflow.normalizeTemplate({videoCodec:'libx264',scaleMode:'exact',width:128,height:72},true);
  const inherited=video(worker,'inherited');
  worker.project.tasks=[own,inherited];
  delete worker.project.templates;
  delete worker.project.globalTemplateId;
  worker.persist();
  const restored=new SessionWorker({isolated:true});
  restored.openProject(source,output);
  assert.equal(restored.project.templates.length,1);
  assert.equal(restored.project.globalTemplateId,'default');
  assert.equal(restored.project.tasks[0].templateScope,'independent');
  assert.equal(restored.project.tasks[1].templateScope,'global');
  assert.equal(workflow.effectiveTemplate(restored.project,restored.project.tasks[0]).videoCodec,'libx264');
  assert.equal(workflow.effectiveTemplate(restored.project,restored.project.tasks[1]).videoCodec,'');
});

test('Q1-F：多个模板作用域隔离、切换全局、保护已被引用的局部模板',async t=>{
  const {worker}=await fixture(t,'q1f-scope-');
  const global=video(worker,'global'),local=video(worker,'local'),independent=video(worker,'independent');
  worker.project.tasks=[global,local,independent];
  const other=worker.createBatchTemplate({name:'局部264',template:{videoCodec:'libx264',scaleMode:'none'}});
  worker.saveItemTemplate('local',{mode:'local',templateId:other.id});
  worker.saveItemTemplate('independent',{mode:'independent',
    template:{videoCodec:'copy',scaleMode:'none'}});
  assert.equal(local.template.videoCodec,'libx264');
  assert.equal(independent.template.videoCodec,'copy');
  const localKey=local.templateKey,ownKey=independent.templateKey;
  worker.saveTemplate({videoCodec:'libx265',scaleMode:'shortEdge',shortEdge:90});
  assert.equal(global.template.videoCodec,'libx265');
  assert.equal(local.templateKey,localKey,'修改全局模板不应影响局部模板');
  assert.equal(independent.templateKey,ownKey,'修改全局模板不应影响独立参数');
  assert.throws(()=>worker.deleteBatchTemplate(other.id),/使用/);
  worker.setGlobalBatchTemplate(other.id);
  assert.equal(worker.project.globalTemplateId,other.id);
  assert.notEqual(local.localTemplateId,other.id,'被提升为全局的模板须保留原局部绑定');
  assert.equal(local.template.videoCodec,'libx264');
  worker.updateBatchTemplate({id:other.id,name:'新全局264',template:{videoCodec:'libx265',scaleMode:'none'}});
  assert.equal(global.template.videoCodec,'libx265');
  assert.equal(local.template.videoCodec,'libx264');
  assert.equal(independent.template.videoCodec,'copy');
  assert.throws(()=>worker.deleteBatchTemplate(other.id),/全局/);
  assert.throws(()=>worker.createBatchTemplate({name:'新全局264'}),/重复/);
  const extra=worker.createBatchTemplate({name:'待删除模板',template:{scaleMode:'none'}});
  worker.deleteBatchTemplate(extra.id);
  assert.equal(worker.project.templates.some(entry=>entry.id===extra.id),false);
});

test('Q1-F：删除历史任务仅移除记录和状态，执行中不可删除',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'q1f-delete-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),output=source+'_output';
  await fsp.mkdir(source);
  const manager=new Manager();
  const previousCount=manager.listSessions().length;
  manager.configure({source,output});
  const id=manager.activeId;
  const sourceVideo=path.join(source,'keep.mp4'),outputVideo=path.join(output,'keep.mp4');
  await fsp.writeFile(sourceVideo,'original');
  await fsp.writeFile(outputVideo,'converted');
  const state=path.join(output,'.h265-720p-state.json');
  assert.equal(fs.existsSync(state),true);
  manager.current.activity='transcoding';
  assert.throws(()=>manager.deleteSession(id),/正在/);
  assert.equal(manager.sessions.length,previousCount+1);
  manager.current.activity='idle';
  manager.deleteSession(id);
  assert.equal(manager.listSessions().length,previousCount);
  assert.equal(manager.listSessions().some(session=>session.id===id),false);
  assert.equal(fs.existsSync(state),false);
  assert.equal(await fsp.readFile(sourceVideo,'utf8'),'original');
  assert.equal(await fsp.readFile(outputVideo,'utf8'),'converted');
  assert.throws(()=>manager.deleteSession(id),/不存在/);
});

test('Q1-F：组合筛选覆盖大小变化、文件名/路径和分辨率',()=>{
  const t={relative:'电视剧/S01/Clip.MP4',status:'done',bytes:1000000,outputBytes:1500000,
    sizeDeltaBytes:500000,outputLarger:true,width:1920,height:1080,targetWidth:1280,targetHeight:720};
  assert.equal(filters.parsePercent(' +50% '),50);
  assert.equal(filters.parsePercent('-5%'),-5);
  assert.equal(filters.parsePercent('a%')!==filters.parsePercent('a%'),true);
  assert.equal(filters.resolutionChange(t),'shrunk');
  assert.equal(filters.matches(t,{keyword:'s01/clip',status:'larger',resolution:'shrunk',
    minPercent:'-5%',maxPercent:'+50%'}),true);
  assert.equal(filters.matches(t,{minPercent:'50.01%'}),false);
  assert.equal(filters.matches(t,{maxPercent:'+49.99%'}),false);
  assert.equal(filters.matches(t,{resolution:'same'}),false);
  assert.equal(filters.matches(t,{keyword:'not there'}),false);
  assert.equal(filters.matches({...t,status:'pending'},{minPercent:'-5%'}),false);
  assert.equal(filters.resolutionChange({...t,targetWidth:1080,targetHeight:1920}),'same');
  assert.equal(filters.resolutionChange({...t,targetWidth:2560,targetHeight:1440}),'enlarged');
  const decreased=filters.sizeLabel({...t,bytes:20*1048576,sizeDeltaBytes:-13*1048576});
  assert.deepEqual(decreased,{state:'decreased',text:'－65.0%|-13.00M'});
  const increased=filters.sizeLabel({...t,bytes:10*1048576,sizeDeltaBytes:2*1048576});
  assert.deepEqual(increased,{state:'increased',text:'＋20.0%|+2.00M'});
  assert.equal(filters.sizeLabel({...t,status:'pending'}),null);
});

test('Q1-F：真实 FFmpeg 复制视频流，生成孪生输出并通过验收',{timeout:30000},async t=>{
  const ready=spawnSync('ffmpeg',['-version'],{encoding:'utf8'});
  if(ready.status!==0){t.skip('运行环境未安装 ffmpeg');return;}
  const {source,worker}=await fixture(t,'q1f-copy-');
  const input=path.join(source,'source.mp4');
  const create=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi',
    '-i','testsrc=size=160x90:rate=10','-t','1','-pix_fmt','yuv420p','-c:v','mpeg4',input],{encoding:'utf8'});
  assert.equal(create.status,0,create.stderr);
  worker.saveTemplate({videoCodec:'copy',scaleMode:'none'});
  await worker.scan();
  assert.equal(worker.project.tasks.length,1);
  assert.equal(worker.project.tasks[0].sourceCodec,'mpeg4');
  await worker.start();
  const completed=worker.project.tasks[0];
  assert.equal(completed.status,'done',completed.error);
  assert.match(completed.command,/-c:v/);
  assert.match(completed.command,/copy/);
  assert.doesNotMatch(completed.command,/-vf|-crf/);
  assert.ok((await fsp.stat(completed.output)).size>0);
  assert.ok(completed.verifiedAt);
});
