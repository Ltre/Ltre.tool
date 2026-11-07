'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createController,DOUBLE_TAP_MS}=require('../public/compare-sync');
class VideoMock {
  constructor(duration=100) {this._time=0;this.duration=duration;this.paused=true;this.ended=false;this.events=new Map();}
  get currentTime(){return this._time;}
  set currentTime(v){this._time=v;if(v<this.duration)this.ended=false;this.dispatch('seeking');}
  addEventListener(name,cb){
    if(!this.events.has(name))this.events.set(name,[]);
    this.events.get(name).push(cb);
  }
  dispatch(name){for(const callback of this.events.get(name)||[])callback({type:name,target:this});}
  play(){
    if(this.ended)return Promise.reject(new Error('结束的媒体必须先重置进度'));
    this.paused=false;this.dispatch('play');return Promise.resolve();
  }
  pause(){const wasPaused=this.paused;this.paused=true;if(!wasPaused)this.dispatch('pause');}
}
function setup(){
  const source=new VideoMock(),output=new VideoMock();
  const toggle={textContent:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;}};
  const state={textContent:''}, errors=[];
  let time=0,serial=0;
  const pending=new Map();
  const controller=createController({source,output,toggle,state,onError:e=>errors.push(e),
    now:()=>time,schedule:fn=>{const id=++serial;pending.set(id,fn);return id;},
    cancel:id=>pending.delete(id)});
  controller.activate();
  function key(direction,repeat=false){
    const e={key:direction,repeat,target:{tagName:'DIV'},preventDefault(){this.prevented=true;},stopPropagation(){}};
    controller.handleKey(e);return e;
  }
  return {controller,source,output,toggle,state,errors,pending,key,setTime:v=>time=v,
    flush:()=>{for(const [id,fn] of [...pending]){pending.delete(id);fn();}}};
}
test('同步播放、暂停、从任一播放器拖动进度及按钮跳转',async()=>{
  const v=setup();
  v.source.currentTime=24;
  assert.equal(v.output.currentTime,24);
  v.output.currentTime=33;
  assert.equal(v.source.currentTime,33);
  await v.controller.playBoth();
  assert.equal(v.source.paused,false);
  assert.equal(v.output.paused,false);
  assert.equal(v.toggle.textContent,'⏸');
  v.source._time=50;v.output._time=48;
  v.source.dispatch('timeupdate');
  assert.equal(v.output.currentTime,50);
  v.controller.seekBy(-8);
  assert.equal(v.source.currentTime,42);
  assert.equal(v.output.currentTime,42);
  v.controller.seekBy(2);
  assert.equal(v.source.currentTime,44);
  assert.equal(v.output.currentTime,44);
  v.controller.toggleBoth();
  assert.equal(v.source.paused,true);
  assert.equal(v.output.paused,true);
  assert.equal(v.toggle.textContent,'▶');
  assert.deepEqual(v.errors,[]);
  v.controller.deactivate();
  assert.equal(v.controller.active,false);
});
test('单方向键±2秒；同方向快速连击总计±8秒，而不是 10 秒',()=>{
  const v=setup();
  v.source.currentTime=60;
  assert.equal(v.key('ArrowLeft').prevented,true);
  assert.equal(v.source.currentTime,60,'首击等待双击判断');
  v.setTime(DOUBLE_TAP_MS-1);
  v.key('ArrowLeft');
  assert.equal(v.source.currentTime,52);
  assert.equal(v.output.currentTime,52);
  assert.equal(v.pending.size,0,'双击应取消单击计时器');
  v.setTime(1000);
  v.key('ArrowRight');
  v.flush();
  assert.equal(v.source.currentTime,54);
  assert.equal(v.output.currentTime,54);
  v.setTime(2000);
  v.key('ArrowRight');
  v.setTime(2000+DOUBLE_TAP_MS-1);
  v.key('ArrowRight');
  assert.equal(v.source.currentTime,62);
  assert.equal(v.output.currentTime,62);
  const ignored=v.key('ArrowRight',true);
  assert.equal(ignored.prevented,undefined);
  assert.equal(v.source.currentTime,62);
  v.controller.deactivate();
  v.key('ArrowLeft');v.flush();
  assert.equal(v.source.currentTime,62);
});
test('切换方向立即结算前一次单击；两个视频时间受共同边界限制',()=>{
  const v=setup();
  v.source.duration=10;v.output.duration=8;
  v.source.currentTime=5;
  v.key('ArrowLeft');v.setTime(50);v.key('ArrowRight');
  assert.equal(v.source.currentTime,3);
  v.flush();
  assert.equal(v.source.currentTime,5);
  v.controller.seekBy(1000);
  assert.ok(v.source.currentTime<8 && v.output.currentTime<8);
  v.controller.seekBy(-1000);
  assert.equal(v.source.currentTime,0);
  assert.equal(v.output.currentTime,0);
});

test('Q1-D：两个视频均播放至末尾后，点击统一播放自动回到 0 秒同时开始',async()=>{
  const v=setup();
  for(const video of [v.source,v.output]){
    video._time=video.duration;
    video.ended=true;
    video.paused=true;
    video.dispatch('ended');
  }
  assert.equal(v.toggle.textContent,'▶');
  // Must use the same toggle path as the compare dialog's bottom play button.
  v.controller.toggleBoth();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(v.source.currentTime,0);
  assert.equal(v.output.currentTime,0);
  assert.equal(v.source.paused,false);
  assert.equal(v.output.paused,false);
  assert.equal(v.source.ended,false);
  assert.equal(v.output.ended,false);
  assert.equal(v.toggle.textContent,'⏸');
  assert.deepEqual(v.errors,[]);
});

test('Q1-D：仅短视频结束时，也同时从头播放，而不是保留另一侧当前位置',async()=>{
  const v=setup();
  v.source.duration=60;
  v.output.duration=45;
  v.source._time=45;
  v.output._time=45;
  v.output.ended=true;
  v.source.paused=true;v.output.paused=true;
  await v.controller.playBoth();
  assert.equal(v.source.currentTime,0);
  assert.equal(v.output.currentTime,0);
  assert.equal(v.source.paused,false);
  assert.equal(v.output.paused,false);
  assert.deepEqual(v.errors,[]);
});

test('Q1-D：末尾附近即使 ended 尚未更新也重播；中途暂停则从当前位置继续',async()=>{
  const v=setup();
  v.source._time=99.96;
  v.output._time=99.96;
  await v.controller.playBoth();
  assert.equal(v.source.currentTime,0);
  assert.equal(v.output.currentTime,0);
  v.controller.pauseBoth();
  v.source.currentTime=32;
  await v.controller.playBoth();
  assert.equal(v.source.currentTime,32);
  assert.equal(v.output.currentTime,32);
  assert.deepEqual(v.errors,[]);
});
