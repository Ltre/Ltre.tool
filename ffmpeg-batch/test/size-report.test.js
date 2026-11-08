'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const fsp=require('node:fs/promises');
const {SessionWorker}=require('../server');

test('Q1-E：历史完成任务的输出变大标记在 API、CSV、命令报告与重启后保持一致',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'q1e-size-report-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),output=path.join(root,'source_output');
  await fsp.mkdir(source);
  const worker=new SessionWorker({isolated:true});
  worker.configure({source,output});
  const grown={id:'grown',relative:'grown.mp4',status:'done',bytes:1000,outputBytes:1500,
    input:path.join(source,'grown.mp4'),output:path.join(output,'grown.mp4')};
  const small={...grown,id:'small',relative:'small.mp4',bytes:1000,outputBytes:800};
  const equal={...grown,id:'equal',relative:'equal.mp4',bytes:1000,outputBytes:1000};
  const pending={...grown,id:'pending',relative:'pending.mp4',status:'pending',bytes:1000,outputBytes:2000};
  const legacy={...grown,id:'legacy',relative:'legacy.mp4',outputBytes:undefined};
  // Prior versions' pending command still included scale; reopening must refresh its plan.
  const oddPending={...pending,id:'odd',relative:'odd.mp4',width:1281,height:719,
    targetWidth:1282,targetHeight:719,
    template:{videoCodec:'libx265',scaleMode:'shortEdge',shortEdge:719,percent:100,crf:''},
    command:'ffmpeg -vf scale=1282:719',temporary:path.join(output,'odd.partial.mp4')};
  worker.project.tasks=[grown,small,equal,pending,legacy,oddPending];
  worker.persist();

  const reopened=new SessionWorker({isolated:true});
  reopened.openProject(source,output);
  const snapshot=reopened.snapshot();
  assert.equal(snapshot.outputLargerCount,1);
  assert.equal(snapshot.counts.done,4);
  assert.deepEqual(snapshot.tasks.map(task=>[task.id,task.outputLarger,task.sizeDeltaBytes]),[
    ['grown',true,500],['small',false,-200],['equal',false,0],
    ['pending',false,null],['legacy',false,null],['odd',false,null]
  ]);
  assert.equal(reopened.project.tasks[0].outputLarger,undefined,'标记通过 API 派生，不修改已有状态文件');
  assert.equal(snapshot.tasks[5].targetWidth,1281,'重启后恢复正确的未处理原始尺寸');
  assert.equal(snapshot.tasks[5].targetHeight,719);
  assert.ok(!snapshot.tasks[5].command.includes('-vf'),snapshot.tasks[5].command);
  const csv=reopened.exportCsv();
  assert.match(csv,/outputLarger,sizeDeltaBytes/,'CSV 表头为未加引号的字段名称');
  assert.match(csv,/"true","500"/);
  assert.match(csv,/"false","-200"/);
  assert.match(reopened.exportCommands(),/grown\.mp4[^\n]*\[输出比原文件大\]/);
  assert.doesNotMatch(reopened.exportCommands(),/small\.mp4[^\n]*\[输出比原文件大\]/);
  const json=JSON.stringify(snapshot);
  assert.match(json,/"outputLarger":true/);
});
