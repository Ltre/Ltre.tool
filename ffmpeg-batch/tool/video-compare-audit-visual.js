

/* 视频对比自动巡检：仅点击“原视频 / 结果视频对比”和对比窗口内明确的关闭控件 */
(async () => {
  if (window.__videoCompareAudit?.running) {
    console.warn('已有巡检在运行');
    return;
  }

  const cfg = {
    segments: 10,
    playMs: 1200,
    settleMs: 180,
    seekTimeoutMs: 12000,
    loadTimeoutMs: 16000,
    visualThreshold: 0.86,
    samplesWidth: 64,
    samplesHeight: 36,
    openTimeoutMs: 7000,
    closeTimeoutMs: 3500
  };

  const state = window.__videoCompareAudit = {
    running: true,
    stopped: false,
    results: [],
    config: cfg,
    stop() {
      this.stopped = true;
      console.warn('已请求停止');
    },
    download() {
      const json = JSON.stringify({
        createdAt: new Date().toISOString(),
        config: cfg,
        results: this.results
      }, null, 2);
      const u = URL.createObjectURL(
        new Blob([json], { type: 'application/json' })
      );
      const a = document.createElement('a');
      a.href = u;
      a.download = 'video-compare-audit.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 3000);
    }
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = el => {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      Number(s.opacity) !== 0 &&
      b.width > 5 && b.height > 5;
  };

  const norm = t => (t || '').replace(/\s+/g, '').trim();
  const target = /^原视频[\/／]结果视频对比$/;
  const elements = () => [
    ...document.querySelectorAll(
      'button,[role="button"],input[type="button"]'
    )
  ];
  const label = el => norm(
    el.innerText || el.value ||
    el.getAttribute('aria-label') || el.textContent
  );
  const isTarget = el => target.test(label(el));
  const targets = elements().filter(isTarget);
  const snapshotVideos = () => new Set(
    [...document.querySelectorAll('video')].filter(shown)
  );
  const rectSort = (a, b) =>
    a.getBoundingClientRect().left -
    b.getBoundingClientRect().left;

  const waitUntil = async (test, timeout) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = test();
      if (value) return value;
      await sleep(100);
    }
    return null;
  };

  const pause = v => {
    try { v.pause(); } catch {}
  };

  const waitEvent = (v, success, ms) => new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      success.forEach(ev => v.removeEventListener(ev, good));
      v.removeEventListener('error', bad);
      clearTimeout(timer);
      resolve(ok);
    };
    const good = () => finish(true);
    const bad = () => finish(false);
    success.forEach(ev =>
      v.addEventListener(ev, good, { once: true })
    );
    v.addEventListener('error', bad, { once: true });
    const timer = setTimeout(() => finish(false), ms);
  });

  const ready = async v => {
    if (
      v.readyState >= 2 &&
      Number.isFinite(v.duration) &&
      v.duration > 0
    ) return true;

    await waitEvent(
      v, ['loadedmetadata', 'loadeddata', 'canplay'],
      cfg.loadTimeoutMs
    );
    return v.readyState >= 2 &&
      Number.isFinite(v.duration) &&
      v.duration > 0;
  };

  const seek = async (v, t) => {
    pause(v);
    const max = Math.max(0, v.duration - 0.08);
    const bounded = Math.max(0, Math.min(max, t));

    if (
      Math.abs(v.currentTime - bounded) < 0.07 &&
      v.readyState >= 2
    ) return true;

    try { v.currentTime = bounded; }
    catch { return false; }

    await Promise.race([
      waitEvent(v, ['seeked'], cfg.seekTimeoutMs),
      sleep(cfg.seekTimeoutMs)
    ]);

    return !v.seeking &&
      Math.abs(v.currentTime - bounded) < 0.6 &&
      v.readyState >= 2;
  };

  const readFrame = v => {
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) {
      throw new Error('视频帧不可读');
    }

    const c = document.createElement('canvas');
    c.width = cfg.samplesWidth;
    c.height = cfg.samplesHeight;

    const x = c.getContext('2d', {
      willReadFrequently: true
    });
    x.drawImage(v, 0, 0, c.width, c.height);
    return x.getImageData(0, 0, c.width, c.height).data;
  };

  const resemblance = (l, r) => {
    let diff = 0, n = 0, lumL = 0, lumR = 0;
    for (let i = 0; i < l.length; i += 4) {
      const a = .2126 * l[i] +
        .7152 * l[i + 1] + .0722 * l[i + 2];
      const b = .2126 * r[i] +
        .7152 * r[i + 1] + .0722 * r[i + 2];
      diff += Math.abs(a - b);
      lumL += a;
      lumR += b;
      n++;
    }
    const mae = diff / n;
    return {
      similarity: +(1 - mae / 255).toFixed(4),
      mae: +mae.toFixed(2),
      meanOriginal: +(lumL / n).toFixed(1),
      meanOutput: +(lumR / n).toFixed(1)
    };
  };

  function findPair(before) {
    const visible = [
      ...document.querySelectorAll('video')
    ].filter(shown);
    const newly = visible.filter(v => !before.has(v));
    const pool = newly.length >= 2 ? newly : visible;
    if (pool.length < 2) return null;

    const candidates = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i], b = pool[j];
        let p = a, ancestor = null;
        while (p && p !== document.body) {
          if (p.contains(b)) {
            ancestor = p;
            break;
          }
          p = p.parentElement;
        }
        if (!ancestor) continue;

        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const score =
          (newly.includes(a) ? 100 : 0) +
          (newly.includes(b) ? 100 : 0) +
          (Math.abs(ar.top - br.top) <
            Math.max(ar.height, br.height) * .8 ? 25 : 0) -
          (Math.abs(ar.left - br.left) < 8 ? 30 : 0) -
          Math.abs(ar.top - br.top) / 100;

        candidates.push({ a, b, ancestor, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) return null;
    const c = candidates[0];
    return {
      videos: [c.a, c.b].sort(rectSort),
      root: c.ancestor
    };
  }

  function modalRoot(pair) {
    let el = pair.root;
    while (el && el !== document.body) {
      if (el.matches(
        'dialog,[role="dialog"],[aria-modal="true"],' +
        '.modal,.dialog,[class*="modal"],[class*="Modal"]'
      )) return el;
      el = el.parentElement;
    }
    return null;
  }

  async function closeCompare(pair) {
    pair.videos.forEach(pause);
    const root = modalRoot(pair);
    const close = root && [
      ...root.querySelectorAll('button,[role="button"]')
    ].filter(shown).find(b =>
      /^(关闭|关掉|close|×|✕|✖|退出|返回)$/i.test(label(b)) ||
      /^(close|关闭)$/i.test(norm(
        b.getAttribute('title') ||
        b.getAttribute('aria-label')
      ))
    );

    if (close && !isTarget(close)) {
      close.click();
    } else {
      console.warn('未找到明确的关闭控件，不进行其他操作');
      return false;
    }

    return Boolean(await waitUntil(
      () => pair.videos.every(v => !shown(v)),
      cfg.closeTimeoutMs
    ));
  }

  console.log(`找到 ${targets.length} 个视频对比按钮`);

  if (!targets.length) {
    console.error('未找到目标按钮，请确认列表已展开');
    state.running = false;
    return;
  }

  try {
    for (let index = 0; index < targets.length; index++) {
      if (state.stopped) break;

      const btn = targets[index];
      if (!btn.isConnected || !shown(btn) || btn.disabled) {
        state.results.push({
          index: index + 1,
          status: 'SKIP',
          reason: '按钮不可用或不可见'
        });
        continue;
      }

      const row = btn.closest(
        'tr,[role="row"],li,' +
        '[class*="file"],[class*="File"],' +
        '[class*="item"],[class*="Item"]'
      );
      const description = (
        row?.innerText ||
        btn.parentElement?.innerText || ''
      ).replace(/\s+/g, ' ').slice(0, 180);

      const entry = {
        index: index + 1,
        description,
        status: 'UNKNOWN',
        points: []
      };
      state.results.push(entry);

      const before = snapshotVideos();
      console.log(
        `[${index + 1}/${targets.length}] 打开：${description}`
      );

      btn.click();

      const pair = await waitUntil(
        () => findPair(before),
        cfg.openTimeoutMs
      );

      if (!pair) {
        entry.status = 'ERROR';
        entry.reason = '未识别到两个可见 video 元素';
        console.warn(entry);
        break;
      }

      const [left, right] = pair.videos;

      if (!(await ready(left)) || !(await ready(right))) {
        entry.status = 'ERROR';
        entry.reason = '视频无法加载有效时长';
      } else {
        const duration = Math.min(
          left.duration, right.duration
        );
        entry.originalDuration = left.duration;
        entry.outputDuration = right.duration;
        entry.durationDiff = Math.abs(
          left.duration - right.duration
        );

        if (entry.durationDiff >
            Math.max(.5, left.duration * .01)) {
          entry.durationWarning = '左右视频时长差异较大';
        }

        for (let n = 0; n < cfg.segments; n++) {
          if (state.stopped) break;

          const point = {
            point: n + 1,
            seconds: null,
            status: 'UNKNOWN'
          };
          entry.points.push(point);

          const available = Math.max(
            0, duration - cfg.playMs / 1000 - .2
          );
          const sec = Math.min(
            available,
            duration * (n + .5) / cfg.segments
          );
          point.seconds = +sec.toFixed(2);

          const [ls, rs] = await Promise.all([
            seek(left, sec),
            seek(right, sec)
          ]);

          if (!ls || !rs) {
            point.status = 'FAIL';
            point.reason = 'seek 失败或超时';
            continue;
          }

          await sleep(cfg.settleMs);

          let started = [];
          try {
            started = await Promise.allSettled([
              left.play(),
              right.play()
            ]);
          } catch (e) {
            started = [{
              status: 'rejected',
              reason: String(e)
            }];
          }

          const starts = [
            left.currentTime,
            right.currentTime
          ];

          await sleep(cfg.playMs);
          pause(left);
          pause(right);

          const moves = [
            left.currentTime - starts[0],
            right.currentTime - starts[1]
          ];

          point.progressOriginal = +moves[0].toFixed(2);
          point.progressOutput = +moves[1].toFixed(2);

          point.outputPlayable =
            right.readyState >= 2 &&
            !right.error &&
            moves[1] >= .55;

          if (started.some(s => s.status === 'rejected')) {
            point.playError = 'play() 被浏览器拒绝';
          }

          try {
            const scores = resemblance(
              readFrame(left), readFrame(right)
            );
            Object.assign(point, scores);

            point.visualMatch =
              scores.similarity >= cfg.visualThreshold;

            point.status =
              point.outputPlayable && point.visualMatch
                ? 'PASS' : 'FAIL';

            if (!point.visualMatch) {
              point.reason = '画面相似度低于阈值';
            }
            if (!point.outputPlayable) {
              point.reason = '结果视频播放时间未正常推进';
            }
          } catch (e) {
            point.status = 'UNVERIFIED';
            point.reason = '无法读取画面：' + e.message;
          }

          console.log(
            `检测点 ${n + 1}/10 @${point.seconds}s`,
            point.status,
            '相似度', point.similarity ?? 'N/A',
            '结果推进', point.progressOutput
          );
        }

        const statuses = entry.points.map(p => p.status);
        entry.status = statuses.includes('FAIL')
          ? 'FAIL'
          : statuses.includes('UNVERIFIED')
            ? 'UNVERIFIED'
            : statuses.length === cfg.segments &&
              statuses.every(x => x === 'PASS')
                ? 'PASS' : 'INCOMPLETE';
      }

      console.log('本条结果：', entry.status, entry);

      const closed = await closeCompare(pair);
      if (!closed) {
        entry.closeWarning = '无法安全关闭对比窗口，巡检停止';
        console.warn(entry.closeWarning);
        break;
      }

      await sleep(150);
    }
  } catch (e) {
    console.error('巡检意外停止：', e);
  } finally {
    state.running = false;
    console.table(state.results.map(r => ({
      序号: r.index,
      结果: r.status,
      通过检测点: r.points?.filter(
        p => p.status === 'PASS'
      ).length || 0,
      总检测点: r.points?.length || 0,
      描述: r.description || r.reason || ''
    })));
    console.log(
      '结果：window.__videoCompareAudit.results'
    );
    console.log(
      '导出报告：__videoCompareAudit.download()'
    );
  }
})();
