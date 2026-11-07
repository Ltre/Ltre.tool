'use strict';
/* Shared player transport. No DOM dependency other than the media/button events. */
(function (root, factory) {
  const exported=factory();
  if (typeof module === 'object' && module.exports) module.exports=exported;
  if (root) root.DualVideoSync=exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DOUBLE_TAP_MS=280;
  function createController({source, output, toggle, state, onError = () => {},
    now = () => Date.now(), schedule = (cb,ms) => setTimeout(cb,ms),
    cancel = id => clearTimeout(id)}) {
    const videos=[source,output];
    let active=false, syncingPlayback=false, pendingKey=null, timer=null;
    const programmatic=new WeakMap();
    const safeTime=video=>Number.isFinite(video.currentTime) ? video.currentTime : 0;
    function commonTime(time) {
      let limit=Infinity;
      for (const video of videos) {
        if (Number.isFinite(video.duration) && video.duration>0) limit=Math.min(limit,video.duration);
      }
      return Math.max(0, Math.min(Number.isFinite(time) ? time : 0, limit === Infinity ? Infinity : Math.max(0,limit-0.05)));
    }
    function place(video,time) {
      const target=commonTime(time);
      if (Math.abs(safeTime(video)-target)<0.04) return;
      try {
        programmatic.set(video,target);
        video.currentTime=target;
      } catch (error) {
        programmatic.delete(video);
        onError('视频暂时无法跳转播放位置：'+(error?.message || error));
      }
    }
    function align(time) {const target=commonTime(time);for(const video of videos)place(video,target);}
    function seekBy(seconds) {
      if(!active)return;
      align(safeTime(source)+seconds);
    }
    function update() {
      if(!toggle)return;
      const playing=active && videos.every(video=>!video.paused && !video.ended);
      toggle.textContent=playing ? '⏸' : '▶';
      toggle.setAttribute('aria-label',playing?'两个视频同步暂停':'两个视频同步播放');
      toggle.setAttribute('aria-pressed',String(playing));
      if(state)state.textContent=playing ? '同步播放中' : active ? '已暂停／准备播放' : '两个视频已就绪';
    }
    async function playBoth(reference=source) {
      if(!active)return;
      align(safeTime(reference));
      syncingPlayback=true;
      try{
        const results=await Promise.allSettled(videos.map(video=>Promise.resolve().then(()=>video.play())));
        const rejected=results.find(result=>result.status==='rejected');
        if(rejected) {
          videos.forEach(video=>video.pause());
          onError('无法同步播放：'+(rejected.reason?.message || String(rejected.reason)));
        }
      }finally{syncingPlayback=false;update();}
    }
    function pauseBoth() {
      if(!active)return;
      syncingPlayback=true;
      videos.forEach(video=>video.pause());
      syncingPlayback=false;
      update();
    }
    function toggleBoth() {
      if(videos.every(video=>!video.paused && !video.ended))pauseBoth();
      else void playBoth(source);
    }
    function mirrorSeek(origin) {
      if(!active)return;
      const expected=programmatic.get(origin);
      programmatic.delete(origin);
      if(expected!==undefined && Math.abs(expected-safeTime(origin))<0.13)return;
      const other=origin===source?output:source;
      place(other,safeTime(origin));
    }
    function mirrorPlay(origin) {
      if(!active||syncingPlayback)return;
      const other=origin===source?output:source;
      syncingPlayback=true;
      place(other,safeTime(origin));
      Promise.resolve().then(()=>other.play()).catch(error=>{
        origin.pause();
        onError('无法同步播放：'+(error?.message || error));
      }).finally(()=>{syncingPlayback=false;update();});
    }
    function mirrorPause(origin) {
      if(!active||syncingPlayback)return;
      const other=origin===source?output:source;
      syncingPlayback=true;other.pause();syncingPlayback=false;update();
    }
    for(const video of videos){
      video.addEventListener('seeking',()=>mirrorSeek(video));
      video.addEventListener('play',()=>mirrorPlay(video));
      video.addEventListener('pause',()=>mirrorPause(video));
      video.addEventListener('ended',()=>mirrorPause(video));
      video.addEventListener('loadedmetadata',()=>{
        if(active && video===output)place(output,safeTime(source));
      });
    }
    source.addEventListener('timeupdate',()=>{
      if(active && !source.paused && !output.paused &&
         Math.abs(safeTime(source)-safeTime(output))>0.35)place(output,safeTime(source));
    });
    function flushArrow() {
      const pending=pendingKey;
      pendingKey=null;timer=null;
      if(pending && active)seekBy(pending.direction*2);
    }
    function clearArrow() {
      if(timer!==null)cancel(timer);
      timer=null;pendingKey=null;
    }
    function handleKey(event) {
      if(!active || (event.key!=='ArrowLeft' && event.key!=='ArrowRight') ||
         event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
         /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || ''))return false;
      event.preventDefault();
      event.stopPropagation?.();
      const direction=event.key==='ArrowLeft'?-1:1;
      const time=now();
      if(pendingKey && pendingKey.direction===direction && time-pendingKey.at<=DOUBLE_TAP_MS){
        clearArrow();seekBy(direction*8);return true;
      }
      if(pendingKey){if(timer!==null)cancel(timer);flushArrow();}
      pendingKey={direction,at:time};
      timer=schedule(flushArrow,DOUBLE_TAP_MS);
      return true;
    }
    function activate(){clearArrow();active=true;update();}
    function deactivate(){
      clearArrow();active=false;syncingPlayback=true;
      videos.forEach(video=>video.pause());syncingPlayback=false;
      update();
    }
    return {activate,deactivate,playBoth,pauseBoth,toggleBoth,seekBy,align,handleKey,
      get active(){return active;}};
  }
  return {createController,DOUBLE_TAP_MS};
});
