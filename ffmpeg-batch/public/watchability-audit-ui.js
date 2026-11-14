let watchabilityRun = null;
const WATCHABILITY_DEFAULTS = Object.freeze({points: 10, playMs: 1200, frameSamples: 3,
  readyTimeoutMs: 15000, seekTimeoutMs: 12000, minAdvanceSeconds: 0.55});
const watchabilitySleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function watchabilityPauseVideos(run) {
  for (const video of run.videos || []) {
    try { video.pause(); } catch {}
  }
}
function watchabilityUpdateControls(run) {
  const pause = $('watchability-pause');
  if (pause) {
    pause.textContent = run.paused ? '继续验收' : '暂停验收';
    pause.setAttribute('aria-label', run.paused ? '继续验收' : '暂停验收');
    pause.disabled = !run.running || run.stopped;
  }
  const stop = $('watchability-stop');
  if (stop) stop.disabled = !run.running || run.stopped;
  const status = $('watchability-live-status');
  if (status) status.textContent = run.stopped ? '正在停止并整理结果…' : run.paused ? '验收已暂停' : run.message || '正在验收';
}
function watchabilityProgress(run, message) {
  run.message = message || '';
  const total = run.tasks.length;
  const pointFraction = run.currentPoint > 0 ? run.currentPoint / run.options.points : 0;
  const percent = total ? Math.min(100, ((run.currentTaskIndex + pointFraction) / total) * 100) : 100;
  $('watchability-progress-fill').style.width = percent.toFixed(2) + '%';
  $('watchability-progress-text').textContent = `${Math.min(run.currentTaskIndex + 1, total)} / ${total} 个视频 · ${Math.min(run.currentPoint, run.options.points)} / ${run.options.points} 个检测点`;
  $('watchability-current-file').textContent = run.currentEntry?.relative || '准备中';
  $('watchability-completed-count').textContent = `${run.results.filter(x => x.status !== 'INCOMPLETE').length} 个已完成`;
  $('watchability-live-status').textContent = run.message || '正在验收';
  watchabilityUpdateControls(run);
}
async function watchabilityWaitForResume(run) {
  while (run.paused && !run.stopped) await watchabilitySleep(50);
  return !run.stopped;
}
async function watchabilityPlayVideos(run) {
  if (!(await watchabilityWaitForResume(run))) return false;
  const results = await Promise.allSettled((run.videos || []).map(video => Promise.resolve().then(() => video.play())));
  if (run.stopped) { watchabilityPauseVideos(run); return false; }
  if (run.paused) { watchabilityPauseVideos(run); return true; }
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected) throw new Error(rejected.reason?.message || '浏览器拒绝播放视频');
  return true;
}
async function watchabilityWaitActive(run, durationMs) {
  let elapsed = 0;
  let wasPaused = false;
  while (elapsed < durationMs) {
    if (run.stopped) return false;
    if (run.paused) {
      wasPaused = true;
      watchabilityPauseVideos(run);
      await watchabilitySleep(40);
      continue;
    }
    if (wasPaused) {
      if (!(await watchabilityPlayVideos(run))) return false;
      wasPaused = false;
    }
    const interval = Math.min(50, durationMs - elapsed);
    const start = performance.now();
    await watchabilitySleep(interval);
    if (!run.paused) elapsed += performance.now() - start;
  }
  return !run.stopped;
}
async function watchabilityWaitReady(video, run, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.stopped) return false;
    if (video.error) return false;
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 &&
        Number.isFinite(video.duration) && video.duration > 0) return true;
    await watchabilitySleep(100);
  }
  return false;
}
async function watchabilitySeek(video, target, run) {
  const bounded = Math.max(0, Math.min(Math.max(0, video.duration - 0.04), target));
  if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - bounded) < 0.08) return true;
  try { video.currentTime = bounded; }
  catch { return false; }
  const deadline = Date.now() + run.options.seekTimeoutMs;
  while (Date.now() < deadline) {
    if (run.stopped) return false;
    if (video.error) return false;
    if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - bounded) < 0.25) return true;
    await watchabilitySleep(40);
  }
  return false;
}
function watchabilityMediaError(video) {
  if (!video.error) return '';
  const names = {1:'媒体加载已中止',2:'媒体网络读取失败',3:'视频解码失败',4:'浏览器不支持此视频格式或编码'};
  return names[video.error.code] || `媒体错误 ${video.error.code || ''}`;
}
function watchabilityPointStatus(point, status, reason) {
  point.status = status;
  if (reason) point.reason = reason;
}
function watchabilityStatusText(status) {
  return ({PASS:'通过',FAIL:'失败',UNVERIFIED:'无法判定',INCOMPLETE:'未完成',ERROR:'错误'})[status] || status;
}
function renderWatchabilityReport(run) {
  const results = run.results;
  const counts = {PASS:0,FAIL:0,UNVERIFIED:0,INCOMPLETE:0,ERROR:0};
  for (const item of results) counts[item.status] = (counts[item.status] || 0) + 1;
  $('watchability-report-summary').textContent =
    `共 ${run.tasks.length} 个已完成视频 · 通过 ${counts.PASS} · 失败 ${counts.FAIL} · 无法判定 ${counts.UNVERIFIED} · 未完成 ${counts.INCOMPLETE + counts.ERROR}`;
  const body = $('watchability-report-body');
  body.replaceChildren();
  for (const item of results) {
    const row = document.createElement('tr');
    const file = document.createElement('td'); file.textContent = item.relative;
    const status = document.createElement('td'); status.textContent = watchabilityStatusText(item.status); status.className = 'watchability-status ' + item.status.toLowerCase();
    const points = document.createElement('td'); points.textContent = `${item.points.filter(p => p.status === 'PASS').length}/${run.options.points}`;
    const scores = item.points.map(p => p.ssim).filter(Number.isFinite);
    const average = document.createElement('td'); average.textContent = scores.length ? `${(scores.reduce((a,b)=>a+b,0)/scores.length*100).toFixed(1)}%` : '—';
    const detailsCell = document.createElement('td');
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = item.reason || (item.points.some(p=>p.status!=='PASS') ? '查看检测点详情' : '10 个检测点均通过');
    details.append(summary);
    const list = document.createElement('ul');
    for (const point of item.points) {
      const li = document.createElement('li');
      const score = Number.isFinite(point.ssim) ? ` · SSIM ${(point.ssim*100).toFixed(1)}%` : '';
      li.textContent = `第 ${point.index} 点 @ ${point.seconds ?? '—'}s：${watchabilityStatusText(point.status)}${score}${point.reason ? ' · ' + point.reason : ''}`;
      list.append(li);
    }
    details.append(list); detailsCell.append(details);
    row.append(file,status,points,average,detailsCell); body.append(row);
  }
  $('watchability-running').classList.add('hidden');
  $('watchability-report').classList.remove('hidden');
  $('watchability-dialog').classList.remove('hidden');
  $('watchability-title').textContent = run.stopped ? '验收已停止 · 可观看性报告' : '验收完成 · 可观看性报告';
}
function downloadWatchabilityReport() {
  if (!watchabilityRun) return;
  const payload = {
    createdAt: watchabilityRun.startedAt,
    finishedAt: watchabilityRun.finishedAt,
    sessionId: watchabilityRun.sessionId,
    configuration: watchabilityRun.options,
    summary: watchabilityRun.summary,
    results: watchabilityRun.results
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'}));
  const link = document.createElement('a');
  link.href = url; link.download = '可观看性验收报告.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
async function startWatchabilityAudit(overrides = {}) {
  if (watchabilityRun?.running) return watchabilityRun.promise;
  if (!model?.configured || !model.id) { toast('请先应用当前任务目录并完成扫描'); return false; }
  const tasks = (model.tasks || []).filter(task => task.status === 'done')
    .slice().sort((a,b) => a.relative.localeCompare(b.relative, 'zh-Hans-CN'));
  if (!tasks.length) { toast('当前任务没有已完成转码的视频'); return false; }

  const options = {...WATCHABILITY_DEFAULTS, ...overrides};
  const run = {
    running:true, paused:false, stopped:false, tasks, options, results:[],
    currentTaskIndex:0, currentPoint:0, currentEntry:null, videos:[],
    startedAt:new Date().toISOString(), finishedAt:null, sessionId:model.id,
    message:'正在准备可观看性验收', summary:null, promise:null,
    pause(){ if(!this.running||this.stopped)return; this.paused=true; watchabilityPauseVideos(this); watchabilityUpdateControls(this); },
    resume(){ if(!this.running||this.stopped)return; this.paused=false; watchabilityUpdateControls(this); },
    stop(){ if(!this.running)return; this.stopped=true; this.paused=false; watchabilityPauseVideos(this); watchabilityUpdateControls(this); }
  };
  watchabilityRun = run;
  window.__watchabilityAudit = run;
  $('watchability-running').classList.remove('hidden');
  $('watchability-report').classList.add('hidden');
  $('watchability-dialog').classList.remove('hidden');
  $('watchability-title').textContent = '正在验收视频可观看性';
  $('watchability-progress-fill').style.width = '0%';
  $('watchability-report-body').replaceChildren();
  watchabilityProgress(run, '正在准备视频列表');

  run.promise = (async () => {
    let comparator = null;
    try {
      comparator = WatchabilityAudit.createVideoComparator();
      for (let index = 0; index < tasks.length; index++) {
        if (run.stopped) break;
        run.currentTaskIndex = index;
        run.currentPoint = 0;
        const task = tasks[index];
        const entry = {id:task.id,relative:task.relative,status:'INCOMPLETE',points:[],reason:'验收尚未完成'};
        run.currentEntry = entry;
        run.results.push(entry);
        watchabilityProgress(run, `正在打开 ${task.relative}`);
        const mutedState = [];
        try {
          openCompare(task);
          compareController.deactivate(); // Disable the normal time-mirroring controller during proportional seeks.
          const source = $('compare-source');
          const output = $('compare-output');
          run.videos = [source,output];
          for (const video of run.videos) {
            mutedState.push({video,muted:video.muted,playbackRate:video.playbackRate});
            video.muted = true; // Muted playback is allowed after asynchronous media loading in Chromium.
            video.playbackRate = 1;
          }
          const [sourceReady,outputReady] = await Promise.all([
            watchabilityWaitReady(source,run,options.readyTimeoutMs),
            watchabilityWaitReady(output,run,options.readyTimeoutMs)
          ]);
          if (run.stopped) { entry.reason='用户停止验收'; break; }
          if (!outputReady) {
            entry.status='FAIL';
            entry.reason=`结果视频无法在浏览器中就绪：${watchabilityMediaError(output) || '加载或解码超时'}`;
          } else if (!sourceReady) {
            const previousVideos = run.videos;
            run.videos = [output];
            const start = output.currentTime;
            let played = false;
            try {
              if (await watchabilityPlayVideos(run)) played = await watchabilityWaitActive(run,options.playMs);
            } catch {}
            output.pause();
            const advanced = played && output.currentTime-start >= options.minAdvanceSeconds;
            if (run.stopped) {
              entry.status='INCOMPLETE'; entry.reason='用户停止验收';
            } else if (!advanced) {
              entry.status='FAIL'; entry.reason='原视频无法读取，且结果视频未能正常播放推进';
            } else {
              entry.status='UNVERIFIED';
              entry.reason = `结果视频可以播放，但原视频不可读取，无法进行画面一致性比较：${watchabilityMediaError(source) || '原视频加载或解码超时'}`;
            }
            run.videos = previousVideos;
          } else {
            const sourceDuration = source.duration;
            const outputDuration = output.duration;
            entry.sourceDuration = Number(sourceDuration.toFixed(3));
            entry.outputDuration = Number(outputDuration.toFixed(3));
            entry.durationDifference = Number(Math.abs(sourceDuration-outputDuration).toFixed(3));
            const windowSeconds = options.playMs / 1000;
            if (sourceDuration < windowSeconds || outputDuration < windowSeconds) {
              entry.status='UNVERIFIED';
              entry.reason=`视频时长不足 ${windowSeconds.toFixed(1)} 秒，无法按要求完成每点 ${windowSeconds.toFixed(1)} 秒的播放检测`;
            } else {
              const sourceRange = sourceDuration-windowSeconds;
              const outputRange = outputDuration-windowSeconds;
              let failed = false;
              let unverified = false;
              for (let pointIndex=0; pointIndex<options.points; pointIndex++) {
                if (run.stopped) break;
                run.currentPoint = pointIndex+1;
                const ratio = options.points <= 1 ? 0 : pointIndex/(options.points-1);
                const sourceAt = sourceRange*ratio;
                const outputAt = outputRange*ratio;
                const point = {index:pointIndex+1,seconds:Number(sourceAt.toFixed(3)),outputSeconds:Number(outputAt.toFixed(3)),status:'INCOMPLETE'};
                entry.points.push(point);
                watchabilityProgress(run, `正在检测 ${task.relative} · 第 ${point.index}/${options.points} 点`);
                const [sourceSeeked,outputSeeked] = await Promise.all([
                  watchabilitySeek(source,sourceAt,run),watchabilitySeek(output,outputAt,run)
                ]);
                if (run.stopped) break;
                if (!outputSeeked) {
                  watchabilityPointStatus(point,'FAIL',`结果视频跳转失败：${watchabilityMediaError(output) || 'seek 超时'}`); failed=true; continue;
                }
                if (!sourceSeeked) {
                  watchabilityPointStatus(point,'UNVERIFIED',`原视频跳转失败：${watchabilityMediaError(source) || 'seek 超时'}`); unverified=true; continue;
                }
                await watchabilityWaitForResume(run);
                if (run.stopped) break;
                const sourceStart=source.currentTime, outputStart=output.currentTime;
                try {
                  if (!(await watchabilityPlayVideos(run))) break;
                  const frameScores=[];
                  const frameWindow=options.playMs/options.frameSamples;
                  for(let sample=0;sample<options.frameSamples;sample++){
                    if(!(await watchabilityWaitActive(run,frameWindow)))break;
                    if(run.stopped)break;
                    frameScores.push(comparator.compare(source,output));
                  }
                  watchabilityPauseVideos(run);
                  if(run.stopped)break;
                  point.sourceAdvance=Number((source.currentTime-sourceStart).toFixed(3));
                  point.outputAdvance=Number((output.currentTime-outputStart).toFixed(3));
                  point.playable=output.readyState>=2 && !output.error && point.outputAdvance>=options.minAdvanceSeconds;
                  if(!point.playable){
                    watchabilityPointStatus(point,'FAIL',`结果视频未正常连续播放 ${windowSeconds.toFixed(1)} 秒`);failed=true;continue;
                  }
                  if(point.sourceAdvance<options.minAdvanceSeconds || !frameScores.length){
                    watchabilityPointStatus(point,'UNVERIFIED','原视频播放未正常推进或无法取得画面帧');unverified=true;continue;
                  }
                  point.ssim=Number((frameScores.reduce((sum,x)=>sum+x.ssim,0)/frameScores.length).toFixed(4));
                  point.similarity=point.ssim;
                  point.lumaMae=Number((frameScores.reduce((sum,x)=>sum+x.lumaMae,0)/frameScores.length).toFixed(2));
                  point.colorMae=Number((frameScores.reduce((sum,x)=>sum+x.colorMae,0)/frameScores.length).toFixed(2));
                  const badFrame=frameScores.find(x=>!x.pass);
                  if(badFrame){
                    watchabilityPointStatus(point,'FAIL',badFrame.reason || '原视频与结果视频画面相似度不足');failed=true;
                  }else watchabilityPointStatus(point,'PASS');
                } catch(error){
                  watchabilityPauseVideos(run);
                  const outputAdvance = output.currentTime-outputStart;
                  point.outputAdvance=Number(outputAdvance.toFixed(3));
                  if(outputAdvance>=options.minAdvanceSeconds){
                    watchabilityPointStatus(point,'UNVERIFIED',`结果视频已播放，但无法完成画面采样：${error.message || error}`);unverified=true;
                  }else{
                    watchabilityPointStatus(point,'FAIL',`结果视频播放失败：${error.message || error}`);failed=true;
                  }
                }
              }
              if(run.stopped){entry.status='INCOMPLETE';entry.reason='用户停止验收';}
              else if(failed)entry.status='FAIL';
              else if(unverified || entry.points.some(p=>p.status==='UNVERIFIED'))entry.status='UNVERIFIED';
              else if(entry.points.length===options.points && entry.points.every(p=>p.status==='PASS')){entry.status='PASS';entry.reason='所有检测点均通过';}
              else {entry.status='INCOMPLETE';entry.reason='检测点未全部完成';}
            }
          }
        } catch(error) {
          entry.status='FAIL'; entry.reason=`打开或验收失败：${error.message || error}`;
        } finally {
          watchabilityPauseVideos(run);
          for(const saved of mutedState){
            try{saved.video.muted=saved.muted;saved.video.playbackRate=saved.playbackRate;}catch{}
          }
          if(currentCompareTask)closeCompare();
          run.videos=[];
        }
        watchabilityProgress(run, `${task.relative}：${watchabilityStatusText(entry.status)}`);
        if(run.stopped)break;
      }
      if(run.stopped){
        const current=run.currentEntry;
        if(current && current.status==='INCOMPLETE' && !current.points.length) current.reason='用户停止验收';
      }
    } catch(error) {
      run.fatalError=error.message || String(error);
      if(run.currentEntry && run.currentEntry.status==='INCOMPLETE')run.currentEntry.reason=`验收程序错误：${run.fatalError}`;
    } finally {
      const recorded = new Set(run.results.map(item=>item.id));
      for (const task of tasks) {
        if (!recorded.has(task.id)) run.results.push({
          id:task.id, relative:task.relative, status:run.fatalError?'UNVERIFIED':'INCOMPLETE',
          points:[], reason:run.fatalError?`验收环境错误：${run.fatalError}`:'用户停止验收，尚未轮到该视频'
        });
      }
      watchabilityPauseVideos(run);
      if(currentCompareTask)closeCompare();
      comparator?.dispose();
      run.running=false;
      run.finishedAt=new Date().toISOString();
      run.summary={
        total:run.tasks.length,
        pass:run.results.filter(x=>x.status==='PASS').length,
        fail:run.results.filter(x=>x.status==='FAIL').length,
        unverified:run.results.filter(x=>x.status==='UNVERIFIED').length,
        incomplete:run.results.filter(x=>x.status==='INCOMPLETE'||x.status==='ERROR').length,
        stopped:run.stopped
      };
      $('watchability-progress-fill').style.width = `${Math.min(100,run.results.length/run.tasks.length*100).toFixed(2)}%`;
      renderWatchabilityReport(run);
      watchabilityUpdateControls(run);
    }
  })();
  return run.promise;
}

$('watchability-pause').addEventListener('click',()=>{
  if(!watchabilityRun?.running)return;
  if(watchabilityRun.paused)watchabilityRun.resume();
  else watchabilityRun.pause();
});
$('watchability-stop').addEventListener('click',()=>watchabilityRun?.stop());
$('watchability-export').addEventListener('click',downloadWatchabilityReport);
$('watchability-report-close').addEventListener('click',()=> $('watchability-dialog').classList.add('hidden'));
window.startWatchabilityAudit = startWatchabilityAudit;
document.addEventListener('click',event=>{
  if(event.target?.closest?.('#verify-watchability'))void window.startWatchabilityAudit();
});
