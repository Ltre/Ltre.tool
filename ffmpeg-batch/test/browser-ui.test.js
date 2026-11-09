'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
  const s=net.createServer();
  await new Promise((resolve,reject)=>s.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}
async function chromeEndpoint(profile,child){
  const portFile=path.join(profile,'DevToolsActivePort');
  for(let i=0;i<180;i++){
    if(fs.existsSync(portFile)){
      const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
      const targets=await fetch('http://127.0.0.1:'+port+'/json').then(r=>r.json()).catch(()=>[]);
      const page=targets.find(target=>target.type==='page');
      if(page?.webSocketDebuggerUrl)return page.webSocketDebuggerUrl;
    }
    if(child.exitCode!==null)throw new Error('Chrome 提前退出 '+child.exitCode);
    await delay(100);
  }
  throw new Error('Chrome 启动超时');
}
async function inspector(url){
  const ws=new WebSocket(url);
  const pending=new Map();let serial=0;
  await new Promise((resolve,reject)=>{
    ws.addEventListener('open',resolve,{once:true});
    ws.addEventListener('error',()=>reject(new Error('CDP WebSocket 连接失败')),{once:true});
  });
  ws.addEventListener('message',ev=>{
    const msg=JSON.parse(ev.data);
    if(msg.id && pending.has(msg.id)){
      const entry=pending.get(msg.id);pending.delete(msg.id);
      msg.error?entry.reject(new Error(msg.error.message)):entry.resolve(msg.result);
    }
  });
  function command(method,params={}){
    const id=++serial;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression){
    const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error('浏览器脚本异常：'+JSON.stringify(result.exceptionDetails).slice(0,500));
    return result.result?.value;
  }
  async function until(expression,message){
    for(let i=0;i<120;i++){
      try{const result=await evaluate(expression);if(result)return result;}catch{}
      await delay(80);
    }
    let diagnostic;
    try {
      diagnostic=await evaluate(`({url:location.href,ready:document.readyState,connection:document.getElementById("connection")?.textContent,source:!!document.getElementById("source"),host:!!document.getElementById("workspace-host"),template:!!document.getElementById("task-workspace-template"),state:document.body?.textContent?.slice(0,200),workspaceType:typeof WorkspaceDOM,
    videoType:typeof DualVideoSync,appType:typeof createDraftWorkspace,errors:window.__pageErrors,
    scripts:[...document.scripts].map(el=>el.src),html:document.documentElement.outerHTML.slice(-160)})`);
    }catch(error){diagnostic={error:error.message};}
    throw new Error('页面等待超时：'+message+'；诊断 '+JSON.stringify(diagnostic));
  }
  return {command,evaluate,until,close:()=>ws.close()};
}
test('真实 Chromium：全工作区克隆、历史任务 DOM 恢复、日志滚动及双视频控制按钮', {timeout:90000}, async t=>{
  if(typeof WebSocket!=='function'){t.skip('需要 Node.js 22+ 内置 WebSocket');return;}
  const chrome=['google-chrome','google-chrome-stable','chromium','chromium-browser']
    .find(name=>spawnSync(name,['--version'],{stdio:'ignore'}).status===0);
  if(!chrome){t.skip('环境未安装 Chromium/Google Chrome');return;}
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ffmpeg-q1c-browser-'));
  const profile=path.join(root,'chrome-profile');
  await fsp.mkdir(profile);
  const port=await freePort();
  const oldPort=process.env.PORT;process.env.PORT=String(port);
  const {server}=require('../server');
  if(oldPort===undefined)delete process.env.PORT;
  else process.env.PORT=oldPort;
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const chromeProcess=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu',
    '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
    {stdio:'ignore'});
  let devtools;
  t.after(async()=>{
    try{devtools?.close();}catch{}
    try{chromeProcess.kill('SIGTERM');}catch{}
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await fsp.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  });
  devtools=await inspector(await chromeEndpoint(profile,chromeProcess));
  await devtools.command('Page.enable');
  await devtools.command('Runtime.enable');
  await devtools.command('Page.addScriptToEvaluateOnNewDocument', {source:
    'window.__pageErrors=[];window.addEventListener("error",function(e){window.__pageErrors.push(e.message+" at "+e.filename+":"+e.lineno)})'});
  await devtools.command('Page.navigate',{url:'http://127.0.0.1:'+port+'/'});
  await devtools.until('document.getElementById("source") && document.getElementById("connection").textContent==="已连接"','首页完成装载');
  const first=await devtools.evaluate(`(() => {
    document.getElementById('new-task').click();
    const host=document.getElementById('workspace-host');
    return {count:host.querySelectorAll(':scope > .task-workspace > .panel').length,
      source:document.getElementById('source').value,
      output:document.getElementById('output').value,
      total:document.getElementById('m-total').textContent,
      exportHref:document.getElementById('export-cmd').getAttribute('href'),
      duplicate:document.querySelectorAll('#source').length,
      draft:document.querySelector('.session-draft')!==null};
  })()`);
  assert.deepEqual(first,{count:5,source:'',output:'',total:'0',exportHref:null,duplicate:1,draft:true});
  const a=path.join(root,'source-A'),b=path.join(root,'source-B');
  await Promise.all([fsp.mkdir(a),fsp.mkdir(b)]);
  async function configure(src){
    await devtools.evaluate(`(() => {
      const el=document.getElementById('source');
      el.value=${JSON.stringify(src)};
      el.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('configure').click();
    })()`);
    return devtools.until(`model && model.configured && model.source===${JSON.stringify(src)} && !draftSession && model.id`,'任务创建 '+src);
  }
  const idA=await configure(a);
  await devtools.evaluate(`(()=>{
    window.__firstControl=document.getElementById('tpl-crf');
    window.__firstControl.value='27';
    document.getElementById('new-task').click();
  })()`);
  const isolated=await devtools.evaluate(`({
    nodeReused:document.getElementById('tpl-crf')===window.__firstControl,
    newValue:document.getElementById('tpl-crf').value,
    formerDisconnected:!window.__firstControl.isConnected,
    count:document.getElementById('m-total').textContent,
    report:document.getElementById('export-json').getAttribute('href')
  })`);
  assert.deepEqual(isolated,{nodeReused:false,newValue:'',formerDisconnected:true,count:'0',report:null});
  const idB=await configure(b);
  assert.notEqual(idB,idA);
  await devtools.evaluate(`(()=>{
    const button=[...document.querySelectorAll('#task-list button.session')]
      .find(button=>button.title.startsWith(${JSON.stringify(a)}));
    if(!button)throw new Error('找不到旧任务');
    button.click();
  })()`);
  await devtools.until(`model && model.id===${JSON.stringify(idA)}`,'切换回旧任务');
  const recovered=await devtools.evaluate(`({
    nodeRestored:document.getElementById('tpl-crf')===window.__firstControl,
    value:document.getElementById('tpl-crf').value,
    oldAttached:window.__firstControl.isConnected
  })`);
  assert.deepEqual(recovered,{nodeRestored:true,value:'27',oldAttached:true});
  const logResult=await devtools.evaluate(`(()=>{
    const t={id:'browser-log',relative:'logs/test.mp4',status:'failed',width:1920,height:1080,
      targetWidth:1280,targetHeight:720,log:Array.from({length:90},(_,i)=>'日志 '+i).join('\\n')};
    model={...model,tasks:[t]};
    openedFiles.add(t.id);
    renderTree(model);
    const log=document.querySelector('.log-code');
    const first={top:log.scrollTop,maximum:log.scrollHeight-log.clientHeight};
    log.scrollTop=0;
    renderTree(model);
    const rebuilt=document.querySelector('.log-code');
    return {...first,restoredTop:rebuilt.scrollTop,atEnd:first.top>=first.maximum-2};
  })()`);
  assert.ok(logResult.maximum>20,JSON.stringify(logResult));
  assert.ok(logResult.atEnd,JSON.stringify(logResult));
  assert.equal(logResult.restoredTop,0);
  const mediaResult=await devtools.evaluate(`(async()=>{
    const src=document.getElementById('compare-source'),out=document.getElementById('compare-output');
    for(const video of [src,out]){
      video.__testTime=0;video.__testPaused=true;video.__testEnded=false;
      Object.defineProperty(video,'duration',{configurable:true,get(){return 60;}});
      Object.defineProperty(video,'currentTime',{configurable:true,
        get(){return this.__testTime;},
        set(value){this.__testTime=value;if(value<this.duration)this.__testEnded=false;this.dispatchEvent(new Event('seeking'));}});
      Object.defineProperty(video,'paused',{configurable:true,get(){return this.__testPaused;}});
      Object.defineProperty(video,'ended',{configurable:true,get(){return this.__testEnded;}});
      video.play=function(){
        if(this.__testEnded)return Promise.reject(new Error('必须先从末尾跳回开头'));
        this.__testPaused=false;this.dispatchEvent(new Event('play'));return Promise.resolve();
      };
      video.pause=function(){this.__testPaused=true;this.dispatchEvent(new Event('pause'));};
    }
    openCompare({id:'browser-log',relative:'logs/test.mp4'});
    src.currentTime=30;
    document.getElementById('compare-back-8').click();
    const afterBack=[src.currentTime,out.currentTime];
    document.getElementById('compare-next-2').click();
    const afterForward=[src.currentTime,out.currentTime];
    document.getElementById('compare-play-toggle').click();
    await new Promise(resolve=>setTimeout(resolve,25));
    const playing=[!src.paused,!out.paused,document.getElementById('compare-play-toggle').textContent];
    document.getElementById('compare-play-toggle').click();
    const paused=[src.paused,out.paused,document.getElementById('compare-play-toggle').textContent];
    const key=(name)=>document.dispatchEvent(new KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));
    key('ArrowLeft');key('ArrowLeft');
    const afterDouble=[src.currentTime,out.currentTime];
    for(const video of [src,out]){
      video.__testTime=60;
      video.__testEnded=true;
      video.__testPaused=true;
      video.dispatchEvent(new Event('ended'));
    }
    document.getElementById('compare-play-toggle').click();
    await new Promise(resolve=>setTimeout(resolve,25));
    const replay=[src.currentTime,out.currentTime,!src.paused,!out.paused,
      document.getElementById('compare-play-toggle').textContent];
    closeCompare();
    return {afterBack,afterForward,playing,paused,afterDouble,replay};
  })()`);
  assert.deepEqual(mediaResult.afterBack,[22,22]);
  assert.deepEqual(mediaResult.afterForward,[24,24]);
  assert.deepEqual(mediaResult.playing,[true,true,'⏸']);
  assert.deepEqual(mediaResult.paused,[true,true,'▶']);
  assert.deepEqual(mediaResult.afterDouble,[16,16]);
  assert.deepEqual(mediaResult.replay,[0,0,true,true,'⏸']);
  const larger=await devtools.evaluate(`(()=>{
    const enlarged={id:'grown',relative:'sub/grown.mp4',status:'done',width:160,height:90,
      targetWidth:160,targetHeight:90,bytes:1000,outputBytes:1500,outputLarger:true,
      sizeDeltaBytes:500};
    const ordinary={...enlarged,id:'ordinary',relative:'ordinary.mp4',outputBytes:750,
      outputLarger:false,sizeDeltaBytes:-250};
    model={...model,tasks:[enlarged,ordinary],outputLargerCount:1};
    document.getElementById('filter').value='all';
    renderSummary(model);
    renderTree(model);
    const totalBadges=document.querySelectorAll('.size-delta-tag').length;
    const summary=document.getElementById('overall-size').textContent;
    document.getElementById('filter').value='larger';
    renderTree(model);
    const filteredRows=document.querySelectorAll('.file-head').length;
    const filteredBadge=document.querySelector('.size-delta-tag.increased')?.textContent;
    document.querySelector('.file-head')?.click();
    const detail=document.querySelector('.file-details')?.textContent || '';
    return {totalBadges,summary,filteredRows,filteredBadge,
      hasIncreaseDetail:detail.includes('增加 500 B (+50.0%)')};
  })()`);
  assert.equal(larger.totalBadges,2);
  assert.match(larger.summary,/输出变大 1 个/);
  assert.equal(larger.filteredRows,1);
  assert.match(larger.filteredBadge,/＋50\.0%\|\+500B/);
  assert.equal(larger.hasIncreaseDetail,true,JSON.stringify(larger));
});
