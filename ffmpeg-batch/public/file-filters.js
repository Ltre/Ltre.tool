'use strict';
// Shared deterministic Q1-F filter and file-size formatter, used by browser and Node tests.
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.FileFilters=api;
})(typeof globalThis==='object'?globalThis:this,()=> {
  function parsePercent(value) {
    if(value==null||String(value).trim()==='')return null;
    const match=/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*%?\s*$/.exec(String(value));
    return match ? Number(match[1]) : NaN;
  }
  function percentChange(t) {
    if(t.status!=='done'||!Number.isSafeInteger(t.bytes)||t.bytes<=0||
       !Number.isSafeInteger(t.sizeDeltaBytes))return null;
    return t.sizeDeltaBytes/t.bytes*100;
  }
  function resolutionChange(t) {
    if(![t.width,t.height,t.targetWidth,t.targetHeight].every(n=>Number.isFinite(n)&&n>0))return null;
    const before=t.width*t.height,after=t.targetWidth*t.targetHeight;
    return after<before?'shrunk':after>before?'enlarged':'same';
  }
  function matches(t,{status='all',keyword='',minPercent='',maxPercent='',resolution='all'}={}) {
    if(status==='larger' && !(t.status==='done'&&t.outputLarger===true))return false;
    if(status==='pending' && !['pending','interrupted','running'].includes(t.status))return false;
    if(status==='failed' && !['failed','conflict'].includes(t.status))return false;
    if(!['all','larger','pending','failed'].includes(status)&&t.status!==status)return false;
    if(keyword && !String(t.relative||'').toLocaleLowerCase().includes(String(keyword).trim().toLocaleLowerCase()))return false;
    if(resolution!=='all' && resolutionChange(t)!==resolution)return false;
    const low=parsePercent(minPercent),high=parsePercent(maxPercent);
    if(Number.isNaN(low)||Number.isNaN(high))return false;
    if(low!==null||high!==null) {
      const value=percentChange(t);
      if(value===null||low!==null&&value<low||high!==null&&value>high)return false;
    }
    return true;
  }
  function sizeLabel(t) {
    const percentage=percentChange(t),delta=t.sizeDeltaBytes;
    if(percentage===null)return null;
    const abs=Math.abs(delta);
    const unit=abs>=1048576?'M':abs>=1024?'K':'B';
    const amount=unit==='M'?abs/1048576:unit==='K'?abs/1024:abs;
    const value=amount.toFixed(unit==='B'?0:2)+unit;
    const state=delta>0?'increased':delta<0?'decreased':'unchanged';
    const sign=delta>0?'+':delta<0?'-':'';
    const percentSign=delta>0?'＋':delta<0?'－':'±';
    return {state,text:percentSign+Math.abs(percentage).toFixed(1)+'%|'+sign+value};
  }
  return {parsePercent,percentChange,resolutionChange,matches,sizeLabel};
});
