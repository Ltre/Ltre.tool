'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm, symlink} = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {LEGACY, EMPTY, normalizeTemplate, calculateTarget, commandArgs, expectedCodec, serveVideo} = require('../workflow');
const {summarize} = require('../public/tree-stats');

test('新任务参数为空时确实省略编码器、缩放、CRF', () => {
  assert.deepEqual(normalizeTemplate(), EMPTY);
  const args = commandArgs({input:'src.mp4', temporary:'dst.partial.mp4', targetWidth:1920,targetHeight:1080,template:EMPTY});
  assert.deepEqual(args,['-i','src.mp4','-movflags','+faststart','-c:a','copy','dst.partial.mp4']);
  assert.equal(expectedCodec({template:EMPTY}),null);
});
test('兼容旧 H.265/720p 模板且输出参数顺序正确', () => {
  const args = commandArgs({input:'src.mp4',temporary:'out.partial.mp4',targetWidth:1280,targetHeight:720,template:LEGACY});
  assert.deepEqual(args,['-i','src.mp4','-c:v','libx265','-movflags','+faststart','-vf','scale=1280:720','-c:a','copy','out.partial.mp4']);
  assert.equal(expectedCodec({template:LEGACY}),'hevc');
});
test('百分比 120/80、单视频固定宽高、CRF 与编码器', () => {
  const fit = (w,h) => ({width:w,height:h});
  assert.deepEqual(calculateTarget({width:1920,height:1080},normalizeTemplate({scaleMode:'percent',percent:120}),fit),{width:2304,height:1296});
  assert.deepEqual(calculateTarget({width:1920,height:1080},normalizeTemplate({scaleMode:'percent',percent:80}),fit),{width:1536,height:864});
  const custom = normalizeTemplate({videoCodec:'libx264',scaleMode:'exact',width:720,height:400,crf:21},true);
  assert.deepEqual(calculateTarget({width:1920,height:1080},custom,fit),{width:720,height:400});
  assert.deepEqual(commandArgs({input:'a',temporary:'b',template:custom,targetWidth:720,targetHeight:400}),['-i','a','-c:v','libx264','-movflags','+faststart','-vf','scale=720:400','-crf','21','-c:a','copy','b']);
  assert.equal(expectedCodec({template:custom}),'h264');
});
test('拒绝无效百分比、单文件尺寸、注入型编码器和不兼容 copy+scale', () => {
  assert.throws(()=>normalizeTemplate({scaleMode:'percent',percent:0}),/百分比|缩放比例/);
  assert.throws(()=>normalizeTemplate({scaleMode:'exact',width:100,height:100}),/缩放模式/);
  assert.throws(()=>normalizeTemplate({scaleMode:'exact',width:0,height:100},true),/指定尺寸/);
  assert.throws(()=>normalizeTemplate({videoCodec:'libx265; rm -rf /'}),/编码器/);
  assert.throws(()=>normalizeTemplate({crf:'64'}),/CRF/);
  assert.throws(()=>normalizeTemplate({videoCodec:'copy',scaleMode:'percent',percent:80}),/复制/);
});
test('目录汇总累计全部层级，异常包含中断与冲突', () => {
  const node = {id:'',files:[{status:'done'}],dirs:new Map([['a',{id:'a',files:[{status:'running'},{status:'failed'}],dirs:new Map([['b',{id:'a/b',files:[{status:'interrupted'},{status:'probe_failed'},{status:'conflict'},{status:'done'}],dirs:new Map()}]])}]])};
  const map = new Map();
  assert.deepEqual(summarize(node,map),{total:7,done:2,problems:4,running:1});
  assert.deepEqual(map.get('a/b'),{total:4,done:1,problems:3,running:0});
});
test('视频预览：Range、HEAD、无效范围、未完成输出和符号链接越界保护', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'ffmpeg-stream-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source = path.join(dir,'source'),output=path.join(dir,'out');
  await mkdir(source);await mkdir(output);
  const body=Buffer.from('A'.repeat(4096));
  const input=path.join(source,'a.mp4'),out=path.join(output,'a.mp4');
  await writeFile(input,body);await writeFile(out,body);
  const task={id:'safe',input,output:out,status:'done'};
  const project={source,output,tasks:[task]};
  const server=http.createServer((req,res)=>serveVideo(req,res,new URL(req.url,'http://127.0.0.1'),project));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/?id=safe&side=`;
  let r=await fetch(url+'output',{headers:{Range:'bytes=5-14'}});
  assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 5-14/4096');assert.equal((await r.arrayBuffer()).byteLength,10);
  r=await fetch(url+'source',{method:'HEAD'});assert.equal(r.status,200);assert.equal(r.headers.get('accept-ranges'),'bytes');
  r=await fetch(url+'source',{headers:{Range:'bytes=9999-'}});assert.equal(r.status,416);
  task.status='pending';r=await fetch(url+'output');assert.equal(r.status,404);
  const outside=path.join(dir,'outside.mp4');await writeFile(outside,body);
  await rm(input);await symlink(outside,input);
  r=await fetch(url+'source');assert.equal(r.status,404);
  r=await fetch(url+'nope');assert.equal(r.status,404);
});
