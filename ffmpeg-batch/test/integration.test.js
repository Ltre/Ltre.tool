'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,rm,stat}=require('node:fs/promises');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const os=require('node:os');
const {server}=require('../server');
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

test('HTTP: 未应用目录直接扫描、模板覆盖、实际转码、历史任务与预览', {timeout:90000},async t=>{
  if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0 || spawnSync('ffprobe',['-version'],{stdio:'ignore'}).status!==0){t.skip('需要 FFmpeg/FFprobe');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'ffmpeg-integration-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source1'),output=source+'_h265_720p';
  await mkdir(source);
  const sample=path.join(source,'sample.mp4');
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=8:d=1','-c:v','mpeg4',sample],{encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://127.0.0.1:'+server.address().port;
  async function api(endpoint, data){const r=await fetch(origin+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const json=await r.json();return {status:r.status,...json};}
  async function status(){return (await (await fetch(origin+'/api/status')).json());}
  async function waitIdle(reason){for(let i=0;i<200;i++){const s=await status();if(s.activity==='idle'&& (reason==='scan' ? s.scannedAt : true))return s;await sleep(100);}throw new Error('operation timeout: '+reason);}
  let r=await api('/api/scan',{source,output});assert.equal(r.status,200,JSON.stringify(r));
  let s=await waitIdle('scan');assert.equal(s.counts.total,1);assert.ok(s.id);
  assert.deepEqual(s.template,{videoCodec:'',scaleMode:'none',percent:100,crf:''});
  assert.equal(s.tasks[0].targetWidth,160);assert.equal(s.tasks[0].targetHeight,90);
  assert.ok(!s.tasks[0].command.includes('-c:v'));
  const firstId=s.id, fileId=s.tasks[0].id;
  r=await api('/api/template',{videoCodec:'libx264',scaleMode:'fraction',fraction:'720/1080'});
  assert.equal(r.status,200);
  s=await status();
  assert.equal(s.template.fraction,'2/3');
  assert.equal(s.tasks[0].targetWidth,106);
  assert.equal(s.tasks[0].targetHeight,60);
  r=await api('/api/template',{videoCodec:'libx264',scaleMode:'shortEdge',shortEdge:72});
  assert.equal(r.status,200);
  s=await status();assert.equal(s.tasks[0].targetWidth,128);assert.equal(s.tasks[0].targetHeight,72);

  // Q1-E: endpoint must not emit a no-op -vf when short edge already equals 90.
  r=await api('/api/template',{videoCodec:'libx264',scaleMode:'shortEdge',shortEdge:90});
  assert.equal(r.status,200);
  s=await status();
  assert.equal(s.tasks[0].targetWidth,160);assert.equal(s.tasks[0].targetHeight,90);
  assert.ok(!s.tasks[0].command.includes('-vf'),s.tasks[0].command);
  r=await api('/api/template',{videoCodec:'libx264',scaleMode:'percent',percent:80,crf:'23'});assert.equal(r.status,200);
  s=await status();assert.equal(s.tasks[0].targetWidth,128);assert.equal(s.tasks[0].targetHeight,72);
  assert.match(s.tasks[0].command,/\-c:v/);assert.match(s.tasks[0].command,/\-crf/);
  r=await api('/api/template/item',{id:fileId,override:{videoCodec:'libx264',scaleMode:'exact',width:120,height:68,crf:'24'}});assert.equal(r.status,200);
  s=await status();assert.equal(s.tasks[0].targetWidth,120);assert.equal(s.tasks[0].targetHeight,68);
  r=await api('/api/start',{});assert.equal(r.status,200);
  s=await waitIdle('transcode');assert.equal(s.tasks[0].status,'done',s.tasks[0].error);
  assert.ok((await stat(s.tasks[0].output)).size>0);
  assert.equal(s.tasks[0].sizeDeltaBytes,s.tasks[0].outputBytes-s.tasks[0].bytes);
  assert.equal(s.tasks[0].outputLarger,s.tasks[0].outputBytes>s.tasks[0].bytes);
  assert.equal(s.outputLargerCount,Number(s.tasks[0].outputLarger));
  let media=await fetch(origin+'/api/video?side=output&id='+encodeURIComponent(fileId),{headers:{Range:'bytes=0-63'}});
  assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,64);
  media=await fetch(origin+'/api/video?side=output&id='+encodeURIComponent(fileId),{headers:{'sec-fetch-site':'cross-site'}});
  assert.equal(media.status,403);
  r=await api('/api/scan',{source:path.join(root,'missing')});assert.equal(r.status,400);
  assert.equal((await status()).activity,'idle');
  const source2=path.join(root,'source2'),output2=source2+'_h265_720p';await mkdir(source2);
  r=await api('/api/config',{source:source2,output:output2});assert.equal(r.status,200);
  s=await status();assert.notEqual(s.id,firstId);assert.equal(s.sessions.length>=2,true);
  // Preview remains pinned to its original session after the UI selects another.
  let pinned=await fetch(origin+'/api/video?side=output&session='+encodeURIComponent(firstId)+'&id='+encodeURIComponent(fileId),{headers:{Range:'bytes=0-31'}});
  assert.equal(pinned.status,206);
  assert.equal((await pinned.arrayBuffer()).byteLength,32);
  pinned=await fetch(origin+'/api/video?side=output&id='+encodeURIComponent(fileId));
  assert.equal(pinned.status,404);

  r=await api('/api/sessions/select',{id:firstId});assert.equal(r.status,200);
  s=await status();assert.equal(s.id,firstId);assert.equal(s.tasks[0].status,'done');
  assert.equal(s.tasks[0].targetWidth,120);
});
