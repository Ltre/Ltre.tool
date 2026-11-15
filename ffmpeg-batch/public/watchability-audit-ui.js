let watchabilityRun = null;
const WATCHABILITY_DEFAULTS = Object.freeze({points: 10, playMs: 1200,
  readyTimeoutMs: 15000, seekTimeoutMs: 8000, minAdvanceSeconds: 0.55});
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
  const pointCount = Math.max(1, run.currentPointCount || run.options.points);
  const withinPoint = Math.max(0, Math.min(1, Number(run.pointProgress) || 0));
  const pointFraction = run.currentPoint > 0 ? ((run.currentPoint - 1 + withinPoint) / pointCount) : 0;
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
async function watchabilityWaitActive(run, durationMs, onProgress) {
  let elapsed = 0;
  let wasPaused = false;
  let lastProgress = 0;
  while (elapsed < durationMs) {
    if (run.stopped || (run.videos || []).some(video => video.error)) return false;
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
    if (onProgress && (elapsed - lastProgress >= 200 || elapsed >= durationMs)) {
      lastProgress = elapsed;
      onProgress(Math.min(1, elapsed / durationMs));
    }
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
async function watchabilitySeek(video, target, run, label) {
  const bounded = Math.max(0, Math.min(Math.max(0, video.duration - 0.04), target));
  if (video.error) return false;
  const timeoutMs = Math.min(run.options.seekTimeoutMs, 8000);
  const deadline = Date.now() + timeoutMs;
  const needsSeek = video.seeking || Math.abs(video.currentTime - bounded) >= 0.08;
  if (needsSeek) {
    let seeked = false;
    const onSeeked = () => { seeked = true; };
    video.addEventListener('seeked', onSeeked);
    try { video.currentTime = bounded; }
    catch {
      video.removeEventListener('seeked', onSeeked);
      return false;
    }
    let lastStatus = 0;
    while (!seeked && Date.now() < deadline && !run.stopped && !video.error) {
      if (!video.seeking && Math.abs(video.currentTime - bounded) < 0.08) {
        seeked = true;
        break;
      }
      if (Date.now() - lastStatus >= 500) {
        watchabilityProgress(run, '正在等待' + (label || '视频') + '完成定位');
        lastStatus = Date.now();
      }
      await watchabilitySleep(25);
    }
    video.removeEventListener('seeked', onSeeked);
    if (run.stopped || video.error) return false;
    if (!seeked && (video.seeking || Math.abs(video.currentTime - bounded) >= 0.25)) return false;
  }

  // Wait for the seek position and decoder state to settle before starting playback.
  let stableSince = 0;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    if (run.stopped || video.error) return false;
    const atTarget = !video.seeking && video.readyState >= 2 &&
      Math.abs(video.currentTime - bounded) < 0.25;
    if (atTarget) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 80) return true;
    } else {
      stableSince = 0;
    }
    if (Date.now() - lastStatus >= 500) {
      watchabilityProgress(run, '正在等待' + (label || '视频') + '解码位置稳定');
      lastStatus = Date.now();
    }
    await watchabilitySleep(25);
  }
  return false;
}
function watchabilityStartFrameMonitor(video, run) {
  let presentedFrames = 0;
  let callbackId = null;
  let stopped = false;
  const supported = typeof video.requestVideoFrameCallback === 'function';
  const schedule = () => {
    if (!supported || stopped || run.stopped || run.paused || video.paused || callbackId !== null) return;
    callbackId = video.requestVideoFrameCallback(() => {
      callbackId = null;
      if (stopped || run.stopped || run.paused || video.paused) return;
      presentedFrames++;
      schedule();
    });
  };
  const onPlaying = () => schedule();
  video.addEventListener('play',onPlaying);
  video.addEventListener('playing',onPlaying);
  schedule();
  return {
    supported,
    get presentedFrames() { return presentedFrames; },
    stop() {
      if (stopped) return;
      stopped = true;
      if (callbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
        try { video.cancelVideoFrameCallback(callbackId); } catch {}
      }
      callbackId = null;
      video.removeEventListener('play',onPlaying);
      video.removeEventListener('playing',onPlaying);
    }
  };
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
const WATCHABILITY_HISTORY_KEY = 'ffmpeg-batch-watchability-reports-v3';
function loadWatchabilityHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(WATCHABILITY_HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function saveWatchabilityHistory(run) {
  const record = {
    id: run.reportId || (run.reportId = 'watch-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)),
    verificationMode:'output-playback-only',
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    options: run.options,
    summary: run.summary,
    results: run.results.map(item => ({
      id:item.id,relative:item.relative,status:item.status,reason:item.reason,
      points:(item.points || []).map(point => ({
        index:point.index,seconds:point.seconds,outputSeconds:point.outputSeconds,
        status:point.status,reason:point.reason,outputAdvance:point.outputAdvance,presentedFrames:point.presentedFrames,
        playbackCompleted:point.playbackCompleted,playbackMs:point.playbackMs
      }))
    }))
  };
  try {
    const history = loadWatchabilityHistory().filter(item => item.id !== record.id);
    history.unshift(record);
    localStorage.setItem(WATCHABILITY_HISTORY_KEY,JSON.stringify(history.slice(0,5)));
    renderWatchabilityHistory();
  } catch (error) {
    console.warn('保存验收记录失败',error);
    toast('报告已生成，但本地存储空间不足，无法保存历史记录');
  }
  return record;
}
function renderWatchabilityHistory() {
  const container = $('watchability-history-list');
  if (!container) return;
  container.replaceChildren();
  const records = loadWatchabilityHistory().filter(item => item.sessionId === model?.id);
  if (!records.length) {
    container.append(el('p','watchability-history-empty','当前任务暂无可观看性验收记录'));
    return;
  }
  for (const record of records) {
    const item = el('div','watchability-history-item');
    const info = el('div','watchability-history-info');
    const summary = record.summary || {};
    info.append(el('strong','',new Date(record.finishedAt || record.startedAt).toLocaleString()));
    info.append(el('span','',
      '通过 ' + (summary.pass || 0) + ' · 失败 ' + (summary.fail || 0) +
      ' · 无法判定 ' + (summary.unverified || 0) + ' · 未完成 ' + (summary.incomplete || 0)));
    const button = el('button','secondary','重新打开报告');
    button.type = 'button';
    button.addEventListener('click',() => openWatchabilityHistory(record.id));
    item.append(info,button);
    container.append(item);
  }
}
function openWatchabilityHistory(id) {
  const record = loadWatchabilityHistory().find(item => item.id === id);
  if (!record || record.sessionId !== model?.id) {
    toast('该记录不属于当前任务');
    return;
  }
  const run = {
    ...record,
    tasks:record.results.map(item => ({id:item.id,relative:item.relative,status:'done'})),
    results:record.results,
    options:{...WATCHABILITY_DEFAULTS,...record.options},
    summary:record.summary,
    stopped:!!record.summary?.stopped,
    running:false,
    history:true
  };
  watchabilityRun = run;
  renderWatchabilityReport(run);
  $('watchability-dialog').classList.remove('hidden');
}
function renderWatchabilityReport(run) {
  const results = run.results || [];
  const options = {...WATCHABILITY_DEFAULTS,...run.options};
  const counts = {PASS:0,FAIL:0,UNVERIFIED:0,INCOMPLETE:0,ERROR:0};
  for (const item of results) counts[item.status] = (counts[item.status] || 0) + 1;
  $('watchability-report-summary').textContent =
    '共 ' + results.length + ' 个视频 · 通过 ' + counts.PASS + ' · 失败 ' + counts.FAIL +
    ' · 无法判定 ' + counts.UNVERIFIED + ' · 未完成 ' + (counts.INCOMPLETE + counts.ERROR);
  const body = $('watchability-report-body');
  body.replaceChildren();
  for (const item of results) {
    const pointsData = item.points || [];
    const row = document.createElement('tr');
    const file = document.createElement('td');
    file.textContent = item.relative;
    const status = document.createElement('td');
    status.textContent = watchabilityStatusText(item.status);
    status.className = 'watchability-status ' + String(item.status || '').toLowerCase();
    const points = document.createElement('td');
    const expected = item.pointCount || pointsData.length || options.points;
    points.textContent = pointsData.filter(point => point.status === 'PASS').length + '/' + expected;
    const advances = pointsData.map(point => point.outputAdvance).filter(Number.isFinite);
    const average = document.createElement('td');
    average.textContent = advances.length
      ? (advances.reduce((sum,value) => sum + value,0) / advances.length).toFixed(2) + ' 秒'
      : '—';
    const detailsCell = document.createElement('td');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = item.reason ||
      (pointsData.every(point => point.status === 'PASS') ? '所有检测点均能正常播放' : '查看检测点详情');
    details.append(summary);
    const list = document.createElement('ul');
    for (const point of pointsData) {
      const li = document.createElement('li');
      const position = Number.isFinite(point.seconds) ? point.seconds.toFixed(2) + 's' : '—';
      const advance = Number.isFinite(point.outputAdvance)
        ? ' · 播放推进 ' + point.outputAdvance.toFixed(2) + 's' : '';
      const frames = Number.isFinite(point.presentedFrames)
        ? ' · 实际呈现帧 ' + point.presentedFrames : '';
      li.textContent = '第 ' + point.index + ' 点 @ ' + position + '：' +
        watchabilityStatusText(point.status) + advance + frames + (point.reason ? ' · ' + point.reason : '');
      list.append(li);
    }
    details.append(list);
    detailsCell.append(details);
    const actionCell = document.createElement('td');
    const compareButton = el('button','secondary','原视频 / 结果视频对比');
    compareButton.type = 'button';
    compareButton.disabled = !model?.tasks?.some(candidate =>
      candidate.id === item.id && candidate.status === 'done');
    compareButton.addEventListener('click',() => {
      const currentTask = model?.tasks?.find(candidate =>
        candidate.id === item.id && candidate.status === 'done');
      if (!currentTask) {
        toast('当前任务中找不到该视频');
        return;
      }
      openCompare(currentTask);
    });
    actionCell.append(compareButton);
    row.append(file,status,points,average,detailsCell,actionCell);
    body.append(row);
  }
  $('watchability-running').classList.add('hidden');
  $('watchability-report').classList.remove('hidden');
  $('watchability-dialog').classList.remove('hidden');
  $('watchability-title').textContent = run.history ? '历史验收报告' :
    run.stopped ? '验收已停止 · 可观看性报告' : '验收完成 · 可观看性报告';
}
function downloadWatchabilityReport() {
  if (!watchabilityRun) return;
  const payload = {
    verificationMode:'output-playback-only',
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
    .slice().sort((a,b) => a.relative.localeCompare(b.relative,'zh-Hans-CN'));
  if (!tasks.length) { toast('当前任务没有已完成转码的视频'); return false; }

  const options = {...WATCHABILITY_DEFAULTS,...overrides};
  const run = {
    running:true, paused:false, stopped:false, tasks, options, results:[],
    currentTaskIndex:0, currentPoint:0, currentPointCount:options.points,
    pointProgress:0, currentEntry:null, videos:[],
    startedAt:new Date().toISOString(), finishedAt:null, sessionId:model.id,
    message:'正在准备视频列表', summary:null, promise:null,
    pause() {
      if (!this.running || this.stopped) return;
      this.paused = true;
      watchabilityPauseVideos(this);
      watchabilityUpdateControls(this);
    },
    resume() {
      if (!this.running || this.stopped) return;
      this.paused = false;
      watchabilityUpdateControls(this);
    },
    stop() {
      if (!this.running) return;
      this.stopped = true;
      this.paused = false;
      watchabilityPauseVideos(this);
      watchabilityUpdateControls(this);
    }
  };
  watchabilityRun = run;
  window.__watchabilityAudit = run;
  $('watchability-running').classList.remove('hidden');
  $('watchability-report').classList.add('hidden');
  $('watchability-dialog').classList.remove('hidden');
  $('watchability-title').textContent = '正在验收视频可观看性';
  $('watchability-progress-fill').style.width = '0%';
  $('watchability-report-body').replaceChildren();
  watchabilityProgress(run,'正在准备视频列表');

  run.promise = (async () => {
    try {
      for (let index = 0; index < tasks.length; index++) {
        if (run.stopped) break;
        run.currentTaskIndex = index;
        run.currentPoint = 0;
        run.currentPointCount = options.points;
        run.pointProgress = 0;
        const task = tasks[index];
        const entry = {
          id:task.id, relative:task.relative, status:'INCOMPLETE',
          points:[], pointCount:0, reason:'验收尚未完成'
        };
        run.currentEntry = entry;
        run.results.push(entry);
        watchabilityProgress(run,'正在加载结果视频 ' + task.relative);

        const output = $('compare-output');
        const originalParent = output.parentNode;
        const originalNext = output.nextSibling;
        const originalClass = output.className;
        const originalStyle = output.getAttribute('style');
        const originalPreload = output.preload;
        const originalControls = output.controls;
        const originalMuted = output.muted;
        const originalPlaybackRate = output.playbackRate;
        const originalSrc = output.getAttribute('src');
        try {
          output.pause();
          output.classList.add('watchability-probe');
          document.body.append(output);
          output.muted = true;
          output.playbackRate = 1;
          output.preload = 'auto';
          output.controls = false;
          run.videos = [output];
          output.src = '/api/video?side=output&session=' +
            encodeURIComponent(run.sessionId) + '&id=' + encodeURIComponent(task.id);
          output.load();

          const ready = await watchabilityWaitReady(output,run,options.readyTimeoutMs);
          if (run.stopped) {
            entry.status = 'INCOMPLETE';
            entry.reason = '用户停止验收';
          } else if (!ready) {
            const check = WatchabilityAudit.evaluatePlaybackSample({
              errorCode:output.error?.code || 0,
              ready:false
            },options);
            entry.status = check.status;
            entry.reason = check.reason || ('结果视频未能就绪：' + watchabilityMediaError(output));
          } else {
            const duration = output.duration;
            const playSeconds = Math.min(options.playMs / 1000,Math.max(0.25,duration * 0.7));
            const playMs = Math.max(150,Math.round(playSeconds * 1000));
            const pointCount = Math.min(options.points,Math.max(1,Math.floor(duration / playSeconds)));
            const maxStart = Math.max(0,duration - playMs / 1000);
            const minAdvanceSeconds = Math.min(options.minAdvanceSeconds,(playMs / 1000) * 0.65);
            const minPresentedFrames = playMs < 500 ? 1 : options.minPresentedFrames;
            entry.duration = Number(duration.toFixed(3));
            entry.pointCount = pointCount;
            run.currentPointCount = pointCount;

            for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
              if (run.stopped) break;
              run.currentPoint = pointIndex + 1;
              run.pointProgress = 0;
              const ratio = pointCount <= 1 ? 0 : pointIndex / (pointCount - 1);
              const target = maxStart * ratio;
              const point = {
                index:pointIndex + 1,
                seconds:Number(target.toFixed(3)),
                status:'INCOMPLETE'
              };
              entry.points.push(point);
              watchabilityProgress(run,'正在定位结果视频 ' + task.relative + ' · 第 ' +
                point.index + '/' + pointCount + ' 点');
              if (!(await watchabilityWaitForResume(run))) {
                point.reason = '用户停止验收';
                break;
              }
              const seeked = await watchabilitySeek(output,target,run,'结果视频');
              if (run.stopped) {
                point.reason = '用户停止验收';
                break;
              }
              if (!seeked) {
                const check = WatchabilityAudit.evaluatePlaybackSample({
                  errorCode:output.error?.code || 0,
                  ready:output.readyState >= 2 && output.videoWidth > 0 && output.videoHeight > 0,
                  seekCompleted:false
                },options);
                point.status = check.status;
                point.reason = check.reason;
                run.pointProgress = 1;
                watchabilityProgress(run,'第 ' + point.index + ' 点无法完成定位');
                continue;
              }

              const startTime = output.currentTime;
              const monitor = watchabilityStartFrameMonitor(output,run);
              let playResolved = false;
              let playbackCompleted = false;
              let playError = '';
              const startedAt = performance.now();
              try {
                const started = await watchabilityPlayVideos(run);
                if (started) {
                  playResolved = true;
                  playbackCompleted = await watchabilityWaitActive(run,playMs,fraction => {
                    run.pointProgress = fraction;
                    watchabilityProgress(run,'正在播放结果视频 ' + task.relative + ' · 第 ' +
                      point.index + '/' + pointCount + ' 点');
                  });
                }
              } catch (error) {
                playError = error.message || String(error);
              } finally {
                try { output.pause(); } catch {}
                monitor.stop();
              }
              if (run.stopped) {
                point.reason = '用户停止验收';
                break;
              }
              const advance = Math.max(0,output.currentTime - startTime);
              const check = WatchabilityAudit.evaluatePlaybackSample({
                errorCode:output.error?.code || 0,
                ready:output.readyState >= 2 && output.videoWidth > 0 && output.videoHeight > 0,
                seekCompleted:true,
                playResolved,
                playError,
                playbackCompleted,
                advance,
                presentedFrames:monitor.presentedFrames,
                frameCallbackSupported:monitor.supported,
                minAdvanceSeconds,
                minPresentedFrames
              },options);
              point.status = check.status;
              point.reason = check.reason;
              point.outputAdvance = Number(advance.toFixed(3));
              point.presentedFrames = monitor.presentedFrames;
              point.playbackCompleted = playbackCompleted;
              point.playbackMs = Math.round(performance.now() - startedAt);
              run.pointProgress = 1;
              watchabilityProgress(run,'第 ' + point.index + ' 点：' + watchabilityStatusText(point.status));
            }

            if (run.stopped) {
              entry.status = 'INCOMPLETE';
              entry.reason = '用户停止验收';
            } else {
              entry.status = WatchabilityAudit.summarizePlayback(entry.points);
              if (entry.status === 'PASS') {
                entry.reason = entry.pointCount + ' 个检测点均能正常连续播放';
              } else {
                const issue = entry.points.find(point => point.status === entry.status) ||
                  entry.points.find(point => point.status !== 'PASS');
                entry.reason = issue?.reason || '检测点未全部取得有效播放证据';
              }
            }
          }
        } catch (error) {
          if (run.stopped) {
            entry.status = 'INCOMPLETE';
            entry.reason = '用户停止验收';
          } else {
            entry.status = 'UNVERIFIED';
            entry.reason = '验收环境异常：' + (error.message || error);
          }
        } finally {
          watchabilityPauseVideos(run);
          run.videos = [];
          try {
            output.removeAttribute('src');
            output.load();
            output.className = originalClass;
            if (originalStyle === null) output.removeAttribute('style');
            else output.setAttribute('style',originalStyle);
            output.preload = originalPreload;
            output.controls = originalControls;
            output.muted = originalMuted;
            output.playbackRate = originalPlaybackRate;
            if (originalSrc !== null) {
              output.setAttribute('src',originalSrc);
              output.load();
            }
            if (originalParent) {
              originalParent.insertBefore(output,
                originalNext && originalNext.parentNode === originalParent ? originalNext : null);
            }
          } catch {}
        }

        if (entry.status !== 'INCOMPLETE') {
          run.currentPoint = run.currentPointCount;
          run.pointProgress = 1;
        }
        watchabilityProgress(run,task.relative + '：' + watchabilityStatusText(entry.status));
        if (run.stopped) break;
      }
    } catch (error) {
      run.fatalError = error.message || String(error);
      if (run.currentEntry && run.currentEntry.status === 'INCOMPLETE') {
        run.currentEntry.reason = '验收程序错误：' + run.fatalError;
      }
    } finally {
      const recorded = new Set(run.results.map(item => item.id));
      for (const task of tasks) {
        if (!recorded.has(task.id)) run.results.push({
          id:task.id, relative:task.relative, status:'INCOMPLETE',
          points:[], pointCount:0,
          reason:run.fatalError ? '验收环境错误：' + run.fatalError : '用户停止验收，尚未轮到该视频'
        });
      }
      watchabilityPauseVideos(run);
      run.videos = [];
      run.running = false;
      run.finishedAt = new Date().toISOString();
      run.summary = {
        total:run.tasks.length,
        pass:run.results.filter(item => item.status === 'PASS').length,
        fail:run.results.filter(item => item.status === 'FAIL').length,
        unverified:run.results.filter(item => item.status === 'UNVERIFIED').length,
        incomplete:run.results.filter(item => item.status === 'INCOMPLETE' || item.status === 'ERROR').length,
        stopped:run.stopped
      };
      $('watchability-progress-fill').style.width =
        Math.min(100,run.results.length / run.tasks.length * 100).toFixed(2) + '%';
      saveWatchabilityHistory(run);
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
$('watchability-history-refresh')?.addEventListener('click',renderWatchabilityHistory);
$('jump-watchability-history')?.addEventListener('click',() => {
  const target = $('watchability-history');
  if (!target) return;
  target.scrollIntoView({behavior:'smooth',block:'end'});
  const next = target.querySelector('.watchability-history-item button') || $('watchability-history-refresh');
  try { next?.focus({preventScroll:true}); } catch { next?.focus(); }
});
window.renderWatchabilityHistory = renderWatchabilityHistory;
window.startWatchabilityAudit = startWatchabilityAudit;
document.addEventListener('click',event=>{
  if(event.target?.closest?.('#verify-watchability'))void window.startWatchabilityAudit();
});
