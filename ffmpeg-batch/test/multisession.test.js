'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Manager,migrateLocalData,DATA_DIR}=require('../server');

test('旧配置迁移到 .data，不覆盖新位置的已有设置',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'manager-migration-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const from=path.join(root,'old'),to=path.join(root,'.data');
  await fsp.mkdir(from);
  await fsp.writeFile(path.join(from,'.manager-config.json'),'{"source":"legacy"}');
  await fsp.writeFile(path.join(from,'.manager-sessions.json'),'{"sessions":[]}');
  migrateLocalData(from,to);
  assert.equal(JSON.parse(await fsp.readFile(path.join(to,'.manager-config.json'),'utf8')).source,'legacy');
  assert.equal(fs.existsSync(path.join(from,'.manager-config.json')),false);
  assert.equal(fs.existsSync(path.join(from,'.manager-sessions.json')),false);
  await fsp.writeFile(path.join(to,'.manager-config.json'),'{"source":"new"}');
  migrateLocalData(from,to);
  assert.equal(JSON.parse(await fsp.readFile(path.join(to,'.manager-config.json'),'utf8')).source,'new');
  assert.ok(DATA_DIR.includes('ffmpeg-batch-tests-'));
});

test('两个会话的扫描/转码状态互相隔离，执行中允许创建、切换与停止其他任务',async t=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'manager-concurrent-'));
  t.after(()=>fsp.rm(temp,{recursive:true,force:true}));
  const sourceA=path.join(temp,'a'),sourceB=path.join(temp,'b');
  await fsp.mkdir(sourceA);await fsp.mkdir(sourceB);
  const manager=new Manager();
  manager.configure({source:sourceA,output:sourceA+'_out'});
  const idA=manager.activeId,workerA=manager.current;
  workerA.project.scanAt=new Date().toISOString();
  workerA.project.tasks=[{id:'a',relative:'a.mp4',status:'pending',bytes:10}];
  workerA.persist();
  let unblock;
  const gate=new Promise(resolve=>unblock=resolve);
  workerA.transcodeOne=async task=>{
    task.status='running';workerA.runningChild={pid:1234567};workerA.persist();
    await gate;
    task.status='done';workerA.runningChild=null;workerA.persist();
  };
  workerA.binaryReady=async()=>true;
  const promiseA=manager.start();
  // Wait for active encoder, without relying on FFmpeg speed.
  for(let n=0;n<50 && workerA.project.tasks[0].status!=='running';n++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(workerA.activity,'transcoding');
  assert.equal(manager.snapshot().counts.running,1);
  manager.configure({source:sourceB,output:sourceB+'_out'});
  const idB=manager.activeId,workerB=manager.current;
  assert.notEqual(idB,idA);
  assert.equal(manager.activity,'idle');
  workerB.project.scanAt=new Date().toISOString();
  workerB.project.tasks=[{id:'b',relative:'b.mp4',status:'pending',bytes:11}];
  workerB.persist();
  let releaseB;
  const gateB=new Promise(resolve=>releaseB=resolve);
  workerB.transcodeOne=async task=>{task.status='running';workerB.runningChild={pid:2222};workerB.persist();await gateB;task.status='done';workerB.runningChild=null;workerB.persist();};
  workerB.binaryReady=async()=>true;
  const promiseB=manager.start();
  for(let n=0;n<50 && workerB.project.tasks[0].status!=='running';n++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(manager.activity,'transcoding');
  assert.equal(workerA.activity,'transcoding');
  assert.equal(manager.listSessions().find(x=>x.id===idA).running,1);
  assert.equal(manager.listSessions().find(x=>x.id===idB).running,1);
  // A symlink alias to an existing output directory must not become a third worker.
  const sourceC=path.join(temp,'c');await fsp.mkdir(sourceC);
  const outputAlias=sourceC+'_out';
  await fsp.symlink(sourceA+'_out',outputAlias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>manager.configure({source:sourceC,output:outputAlias}),/输出目录已被另一任务占用/);

  manager.selectSession(idA);
  assert.equal(manager.snapshot().counts.running,1);
  manager.pause();
  assert.equal(workerA.shouldPause,true);
  assert.equal(workerB.shouldPause,false);
  manager.selectSession(idB);
  assert.equal(workerB.shouldPause,false);
  releaseB();await promiseB;
  assert.equal(workerB.project.tasks[0].status,'done');
  assert.equal(workerA.project.tasks[0].status,'running');
  unblock();await promiseA;
  manager.selectSession(idA);
  assert.equal(manager.snapshot().counts.done,1);
  assert.equal(manager.snapshot().counts.running,0);
  assert.equal(manager.listSessions().find(x=>x.id===idB).done,1);
  // A second manager recovers both sessions from the persisted index.
  const reopened=new Manager();
  assert.equal(reopened.listSessions().length>=2,true);
  reopened.selectSession(idA);
  assert.equal(reopened.snapshot().counts.done,1);
  reopened.selectSession(idB);
  assert.equal(reopened.snapshot().counts.done,1);
});

test('执行中切换不触发运行 worker 的项目重新加载',async t=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'manager-select-'));
  t.after(()=>fsp.rm(tmp,{recursive:true,force:true}));
  const mgr=new Manager();
  const source=path.join(tmp,'videos');await fsp.mkdir(source);
  mgr.configure({source,output:source+'_out'});
  const id=mgr.activeId,reference=mgr.current.project;
  mgr.current.activity='verifying';
  mgr.selectSession(id);
  assert.strictEqual(mgr.current.project,reference);
  assert.equal(mgr.activity,'verifying');
  mgr.current.activity='idle';
});

test('两个真实 FFmpeg 子进程可在不同任务中并行执行并各自验收', {timeout:90000},async t=>{
  if(process.platform==='win32'){t.skip('此项使用 POSIX shell 包装器；Windows 由独立队列测试覆盖');return;}
  const {spawnSync}=require('node:child_process');
  const real=spawnSync('sh',['-c','command -v ffmpeg'],{encoding:'utf8'}).stdout?.trim();
  if(!real || spawnSync('ffprobe',['-version'],{stdio:'ignore'}).status!==0){t.skip('需要 FFmpeg/FFprobe');return;}
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'manager-real-parallel-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin');await fsp.mkdir(bin);
  const wrapper=path.join(bin,'ffmpeg');
  await fsp.writeFile(wrapper,'#!/bin/sh\nsleep 3\nexec "'+real.replace(/"/g,'\\"')+'" "$@"\n');
  await fsp.chmod(wrapper,0o755);
  const mgr=new Manager(),workers=[];
  const jobs=[];
  for(const name of ['one','two']){
    const source=path.join(root,'video-'+name),output=source+'_out';
    await fsp.mkdir(source);
    const input=path.join(source,'sample.mp4');
    const generated=spawnSync(real,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=8:d=1','-c:v','mpeg4',input],{encoding:'utf8'});
    assert.equal(generated.status,0,generated.stderr);
    mgr.configure({source,output});
    const worker=mgr.current;
    await worker.scan();
    assert.equal(worker.project.tasks.length,1);
    worker.saveTemplate({videoCodec:'libx264',scaleMode:'shortEdge',shortEdge:60});
    worker.binaryReady=async()=>true;
    workers.push(worker);
    jobs.push({id:mgr.activeId,worker});
  }
  const oldPath=process.env.PATH;
  let taskOne,taskTwo;
  try{
    process.env.PATH=bin+path.delimiter+oldPath;
    mgr.selectSession(jobs[0].id);
    taskOne=workers[0].start();
    mgr.selectSession(jobs[1].id);
    taskTwo=workers[1].start();
    let simultaneouslyRunning=false;
    for(let i=0;i<80;i++){
      if(workers.every(w=>w.activity==='transcoding' && w.project.tasks[0].status==='running' && w.runningChild?.pid)){
        simultaneouslyRunning=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(simultaneouslyRunning,'两个真实 ffmpeg 子进程应该同时运行');
    assert.notEqual(workers[0].runningChild.pid,workers[1].runningChild.pid);
    assert.equal(mgr.listSessions().find(s=>s.id===jobs[0].id).running,1);
    assert.equal(mgr.listSessions().find(s=>s.id===jobs[1].id).running,1);
    await Promise.all([taskOne,taskTwo]);
    for(const worker of workers){
      assert.equal(worker.project.tasks[0].status,'done',worker.project.tasks[0].error);
      assert.ok((await fsp.stat(worker.project.tasks[0].output)).size>0);
    }
  }finally{
    process.env.PATH=oldPath;
    for(const worker of workers){
      if(worker.activity==='transcoding')worker.stop();
    }
    await Promise.allSettled([taskOne,taskTwo].filter(Boolean));
  }
});
