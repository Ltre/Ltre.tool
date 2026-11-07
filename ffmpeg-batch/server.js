'use strict';

/** Zero-dependency, local-only H.265 batch manager. Requires Node.js >= 18. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const workflow = require('./workflow');

const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, '.manager-config.json');
const REGISTRY_FILE = path.join(APP_DIR, '.manager-sessions.json');
const STATE_FILE = '.h265-720p-state.json';
const PORT = Number(process.env.PORT || 4008);
const BIND = '127.0.0.1'; // never expose file-system browsing to the LAN
const EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.avi', '.ts', '.m2ts', '.mts', '.webm', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.vob']);
const RETAIN_CONTAINER = new Set(['.mp4', '.mkv', '.mov']); // .m4v selects FFmpeg's ipod muxer, which may reject HEVC
const PROBE_LIMIT = 3;
const MAX_JSON = 1024 * 1024;

const now = () => new Date().toISOString();
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function asPortable(p) { return p.split(path.sep).join('/'); }
function readableError(err) { return (err && (err.message || String(err))) || '未知错误'; }
function shellQuote(s) {
  const v = String(s);
  if (process.platform === 'win32') return '"' + v.replace(/"/g, '\\"') + '"';
  return "'" + v.replace(/'/g, "'\\''") + "'";
}
function bytesText(n) {
  if (n == null) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0; let a = n;
  while (a >= 1024 && i < units.length - 1) { a /= 1024; i++; }
  return `${a.toFixed(i ? 2 : 0)} ${units[i]}`;
}
function outRelName(rel) {
  const ext = path.extname(rel).toLowerCase();
  // -c:a copy + HEVC is not legal in WebM and some legacy containers.
  // Append .mkv rather than replacing the extension to avoid collisions.
  return RETAIN_CONTAINER.has(ext) ? rel : `${rel}.mkv`;
}
function even(n) { return Math.max(2, Math.round(n / 2) * 2); }
function targetSize(width, height) {
  if (!(width > 0 && height > 0)) throw new Error('无效源分辨率');
  const factor = Math.min(1, 1280 / width, 720 / height);
  // Never increase either axis, even for odd-sized sources that need a 2-pixel alignment.
  const safeEven = (n, maximum) => Math.max(2, Math.min(even(n), Math.floor(maximum / 2) * 2));
  return { width: safeEven(width * factor, Math.min(width, 1280)), height: safeEven(height * factor, Math.min(height, 720)) };
}
function rotationFor(stream) {
  const tag = stream.tags?.rotate;
  const fromSide = (stream.side_data_list || []).find(x => Number.isFinite(Number(x.rotation)))?.rotation;
  return Number(fromSide ?? tag ?? 0) || 0;
}
function extractMeta(json) {
  const stream = (json.streams || []).find(s => s.codec_type === 'video');
  if (!stream) throw new Error('ffprobe 未发现视频流');
  const angle = ((rotationFor(stream) % 360) + 360) % 360;
  const rotated = angle === 90 || angle === 270;
  const rawWidth = Number(stream.width), rawHeight = Number(stream.height);
  const width = rotated ? rawHeight : rawWidth;
  const height = rotated ? rawWidth : rawHeight;
  const audio = (json.streams || []).find(s => s.codec_type === 'audio');
  const duration = Number(json.format?.duration || stream.duration || 0);
  return { width, height, rotation: angle, codec: stream.codec_name || '', audioCodec: audio?.codec_name || null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    bitrate: Number(json.format?.bit_rate) || null };
}
function runProgram(bin, args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', finished = false;
    const limit = 8 * 1024 * 1024;
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${bin} 超时（${timeout / 1000}秒）`)); }, timeout);
    function finish(error, result) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    }
    child.on('error', e => finish(new Error(`${bin}: ${readableError(e)}`)));
    child.stdout.on('data', d => { out += d.toString(); if (out.length > limit) { child.kill(); finish(new Error(`${bin} 输出过大`)); } });
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-limit); });
    child.on('close', code => code === 0 ? finish(null, { stdout: out, stderr: err }) : finish(new Error(`${bin} 退出码 ${code}: ${(err || out).slice(-1200)}`)));
  });
}
async function probe(file) {
  const res = await runProgram('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  try { return extractMeta(JSON.parse(res.stdout)); }
  catch (e) { throw new Error(`解析 ffprobe 失败：${readableError(e)}`); }
}
async function checkOutput(task) {
  const st = await fsp.stat(task.output).catch(() => null);
  if (!st || !st.isFile() || st.size <= 0) throw new Error('输出文件不存在或大小为 0');
  const actual = await probe(task.output);
  const expected = workflow.expectedCodec(task);
  if (expected && actual.codec !== expected) throw new Error(`视频编码不是 ${expected}，而是 ${actual.codec}`);
  if (actual.width !== task.targetWidth || actual.height !== task.targetHeight) {
    throw new Error(`输出尺寸 ${actual.width}×${actual.height}，期望 ${task.targetWidth}×${task.targetHeight}`);
  }
  if (task.audioCodec && task.audioCodec !== actual.audioCodec) {
    throw new Error(`音频编码 ${actual.audioCodec || '无'}，源音频编码 ${task.audioCodec}，未完整实现 -c:a copy`);
  }
  if (task.duration && actual.duration && Math.abs(task.duration - actual.duration) > Math.max(1.0, task.duration * 0.02)) {
    throw new Error(`时长偏差过大：源 ${task.duration.toFixed(2)}s，输出 ${actual.duration.toFixed(2)}s`);
  }
  return { outputBytes: st.size, verifiedAt: now(), actualDuration: actual.duration };
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.writing`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function ensureSibling(source, output) {
  if (!path.isAbsolute(source) || !path.isAbsolute(output)) throw new Error('路径必须是绝对路径');
  if (source === path.parse(source).root) throw new Error('不能以整个磁盘或文件系统根目录作为视频根目录');
  if (path.normalize(source).toLowerCase() === path.normalize(output).toLowerCase()) throw new Error('源目录与输出目录不能相同');
  if (path.normalize(path.dirname(source)).toLowerCase() !== path.normalize(path.dirname(output)).toLowerCase()) {
    throw new Error('输出目录必须与源目录同级（孪生目录）');
  }
  if (path.basename(output).startsWith('.')) throw new Error('输出目录名称不能以点开头');
}
function idForTask(rel) { return Buffer.from(rel, 'utf8').toString('base64url'); }
function temporaryOutput(final) {
  const ext = path.extname(final);
  return `${final.slice(0, -ext.length)}.partial${ext}`;
}
function commandFor(task) {
  const args = workflow.commandArgs(task);
  return { args, display: 'ffmpeg ' + args.map(shellQuote).join(' ') };
}
function parseTime(s) { const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g; let x, last; while ((x = m.exec(s))) last = x; return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null; }

class Manager {
  constructor() {
    this.project = null;
    this.activity = 'idle';
    this.note = '';
    this.scanProgress = { done: 0, total: 0 };
    this.shouldPause = false;
    this.runningChild = null;
    this.stopRequested = false;
    const registry = readJson(REGISTRY_FILE);
    this.sessions = Array.isArray(registry?.sessions) ? registry.sessions : [];
    this.activeId = null;
    const selected = this.sessions.find(s => s.id === registry?.activeId) || this.sessions[0];
    const config = readJson(CONFIG_FILE);
    const candidate = selected || (config?.source && config?.output ? config : null);
    if (candidate) {
      try {
        ensureSibling(candidate.source, candidate.output);
        if (!fs.existsSync(candidate.source)) throw new Error('源目录当前不存在');
        this.openProject(candidate.source, candidate.output);
      } catch (e) { this.note = `无法恢复上次任务：${readableError(e)}`; }
    }
  }
  get stateFile() { return this.project ? path.join(this.project.output, STATE_FILE) : null; }
  openProject(source, output) {
    const old = readJson(path.join(output, STATE_FILE));
    if (old && (old.source !== source || old.output !== output)) {
      throw new Error('输出目录已经属于其他任务，不能复用');
    }
    let session = this.sessions.find(s => s.source === source && s.output === output);
    if (!session) {
      session = { id: old?.id || randomUUID(), source, output, createdAt: old?.createdAt || now() };
      this.sessions.unshift(session);
    }
    this.project = old && old.source === source && old.output === output
      ? old : { version: 2, id: session.id, source, output, createdAt: now(), scanAt: null, template: {...workflow.EMPTY}, tasks: [], scanErrors: [] };
    this.project.id = session.id;
    if (!this.project.template) this.project.template = {...workflow.LEGACY};
    for (const t of this.project.tasks) {
      if (!t.template) t.template = {...workflow.LEGACY};
      if (t.status === 'running') { t.status = 'interrupted'; t.error = '上次进程中断；可重新开始（会清理残留的 .partial 文件）'; t.pid = null; }
    }
    this.activeId = session.id;
    this.persist(); this.persistRegistry();
    atomicJson(CONFIG_FILE, { source, output });
  }
  persist() { if (this.project) atomicJson(this.stateFile, this.project); }
  persistRegistry() { atomicJson(REGISTRY_FILE, {version: 1, activeId: this.activeId, sessions: this.sessions}); }
  selectSession(id) {
    if (this.activity !== 'idle') throw new Error('当前有任务正在执行，不能切换');
    const session = this.sessions.find(s => s.id === id);
    if (!session) throw new Error('任务不存在');
    this.openProject(session.source, session.output);
    this.note = '已切换到历史任务';
  }
  listSessions() {
    return this.sessions.map(s => {
      const data = s.id === this.activeId ? this.project : readJson(path.join(s.output, STATE_FILE));
      const tasks = data?.tasks || [];
      return {...s, total: tasks.length, done: tasks.filter(t => t.status === 'done').length,
        failed: tasks.filter(t => ['failed','probe_failed','conflict','interrupted'].includes(t.status)).length,
        scannedAt: data?.scanAt || null};
    });
  }
  refreshTemplate(t) {
    if (!(t.width > 0 && t.height > 0)) return;
    const template = workflow.effectiveTemplate(this.project, t);
    const key = JSON.stringify(template);
    const oldKey = t.templateKey || JSON.stringify(t.template || workflow.LEGACY);
    const changed = key !== oldKey;
    const target = workflow.calculateTarget(t, template, targetSize);
    t.template = template; t.templateKey = key;
    t.targetWidth = target.width; t.targetHeight = target.height;
    t.command = commandFor(t).display;
    if (changed) {
      t.progress = 0; t.verifiedAt = null; t.outputBytes = null;
      if (t.status === 'done' || t.status === 'conflict') {
        t.status = 'conflict'; t.error = '转码模板已变更，原有输出文件不会被覆盖；请移走旧输出文件再重试，或创建新任务并指定新输出目录';
      } else if (t.status !== 'probe_failed') {t.status = 'pending'; t.error = '';}
    }
  }
  saveTemplate(template) {
    if (!this.project) throw new Error('请先创建任务');
    if (this.activity !== 'idle') throw new Error('处理期间不可修改模板');
    this.project.template = workflow.normalizeTemplate(template, false);
    for (const t of this.project.tasks) this.refreshTemplate(t);
    this.persist(); this.note = '已保存当前任务的批量转码模板';
  }
  saveItemTemplate(id, override) {
    if (!this.project) throw new Error('请先创建任务');
    if (this.activity !== 'idle') throw new Error('处理期间不可修改模板');
    const t = this.project.tasks.find(t => t.id === id);
    if (!t) throw new Error('未找到该视频');
    t.override = override == null ? null : workflow.normalizeTemplate(override, true);
    this.refreshTemplate(t); this.persist();
    this.note = '已更新该视频的转码模板';
  }
  configure(input) {
    if (this.activity !== 'idle') throw new Error('扫描、转码或验收进行中，不能切换项目');
    const source = path.resolve(String(input.source || '').trim());
    if (!input.source || !String(input.source).trim()) throw new Error('请填写源目录');
    const st = fs.statSync(source, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new Error('源目录不存在或不可访问');
    const output = input.output && String(input.output).trim()
      ? path.resolve(String(input.output).trim()) : path.join(path.dirname(source), `${path.basename(source)}_h265_720p`);
    ensureSibling(source, output);
    // Prevent obvious nested symlink aliasing from causing recursive scan or data damage.
    if (fileExists(path.join(source, STATE_FILE))) throw new Error('源目录包含管理状态文件，请确认没有把旧输出目录当成源目录');
    if (fs.existsSync(output)) {
      const realSource = fs.realpathSync.native(source).toLowerCase();
      const realOutput = fs.realpathSync.native(output).toLowerCase();
      const rel = path.relative(realSource, realOutput);
      if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) {
        throw new Error('输出目录实际指向源目录或其子目录（可能由于符号链接），拒绝执行');
      }
    }
    this.openProject(source, output);
    this.note = '项目已设置；点击“扫描视频”获取各文件实际分辨率和转码命令';
  }
  snapshot() {
    const tasks = this.project?.tasks || [];
    const counts = { total: tasks.length, pending: 0, running: 0, done: 0, failed: 0, interrupted: 0, probe_failed: 0, conflict: 0 };
    let sourceBytes = 0, outputBytes = 0;
    for (const t of tasks) { counts[t.status] = (counts[t.status] || 0) + 1; sourceBytes += t.bytes || 0; if (t.status === 'done') outputBytes += t.outputBytes || 0; }
    return { configured: !!this.project, id: this.activeId, sessions: this.listSessions(), template: this.project?.template || workflow.EMPTY, source: this.project?.source || '', output: this.project?.output || '',
      activity: this.activity, shouldPause: this.shouldPause, note: this.note,
      scannedAt: this.project?.scanAt || null, scanProgress: this.scanProgress,
      scanErrors: this.project?.scanErrors || [], counts, sourceBytes, outputBytes, tasks };
  }
  async scan() {
    if (!this.project) throw new Error('请先设置源目录');
    if (this.activity !== 'idle') throw new Error('已有操作在执行');
    this.activity = 'scanning'; this.note = '正在扫描目录树…'; this.scanProgress = { done: 0, total: 0 };
    try {
      const found = [];
      const errors = [];
      const dirs = [this.project.source];
      while (dirs.length) {
        const dir = dirs.pop();
        let children;
        try { children = await fsp.readdir(dir, { withFileTypes: true }); }
        catch (e) { errors.push(`${dir}: ${readableError(e)}`); continue; }
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const full = path.join(dir, child.name);
          if (child.isDirectory()) dirs.push(full);
          else if (child.isFile() && EXTENSIONS.has(path.extname(child.name).toLowerCase())) found.push(full);
        }
      }
      found.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
      this.scanProgress.total = found.length;
      const previous = new Map(this.project.tasks.map(t => [t.relative, t]));
      const results = new Array(found.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < found.length) {
          const i = cursor++;
          const filename = found[i];
          const relative = asPortable(path.relative(this.project.source, filename));
          const output = path.join(this.project.output, ...outRelName(relative).split('/'));
          const old = previous.get(relative);
          let stat = null;
          try {
            stat = await fsp.stat(filename);
            const st = stat;
            const meta = await probe(filename);
            const template = workflow.effectiveTemplate(this.project, old);
            const target = workflow.calculateTarget(meta, template, targetSize);
            const templateKey = JSON.stringify(template);
            const unchanged = !!old && old.bytes === st.size && old.mtimeMs === st.mtimeMs && old.output === output
              && old.targetWidth === target.width && old.targetHeight === target.height
              && (old.templateKey || JSON.stringify(old.template || workflow.LEGACY)) === templateKey;
            const oldStatus = unchanged ? old.status : 'pending';
            let status = oldStatus === 'running' ? 'interrupted' : oldStatus;
            if (status === 'done' && !fileExists(output)) status = 'pending';
            const entry = {
              id: idForTask(relative), relative, input: filename, output, temporary: temporaryOutput(output),
              bytes: st.size, mtimeMs: st.mtimeMs, width: meta.width, height: meta.height,
              rotation: meta.rotation, targetWidth: target.width, targetHeight: target.height,
              template, templateKey, override: old?.override || null,
              sourceCodec: meta.codec, audioCodec: meta.audioCodec, duration: meta.duration,
              status: status === 'probe_failed' ? 'pending' : status,
              error: unchanged && status !== 'pending' ? (old.error || '') : '',
              progress: status === 'done' ? 100 : 0, speed: '',
              startedAt: unchanged ? old.startedAt || null : null, finishedAt: unchanged ? old.finishedAt || null : null,
              verifiedAt: unchanged ? old.verifiedAt || null : null, outputBytes: unchanged ? old.outputBytes || null : null,
              attempts: unchanged ? old.attempts || 0 : 0, log: unchanged ? old.log || '' : ''
            };
            entry.command = commandFor(entry).display;
            results[i] = entry;
          } catch (e) {
            results[i] = { id: idForTask(relative), relative, input: filename, output, status: 'probe_failed', error: readableError(e),
              bytes: stat?.size || 0, command: '', progress: 0, log: '' };
          }
          this.scanProgress.done++;
          if (this.scanProgress.done % 5 === 0 || this.scanProgress.done === this.scanProgress.total) {
            this.note = `正在 ffprobe 检查 ${this.scanProgress.done}/${this.scanProgress.total} 个文件`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PROBE_LIMIT, found.length) }, worker));
      // Stable final ordering by original directory hierarchy, then filename.
      this.project.tasks = results;
      this.project.scanErrors = errors;
      this.project.scanAt = now();
      this.persist();
      this.note = `扫描完成：${results.length} 个候选视频，${results.filter(t => t.status === 'probe_failed').length} 个无法探测` + (errors.length ? `，${errors.length} 个目录读取失败（见详细状态报告）` : '') + '。';
    } catch (e) {
      this.note = `扫描失败：${readableError(e)}`;
    } finally { this.activity = 'idle'; }
  }
  async start() {
    if (!this.project?.scanAt) throw new Error('请先扫描视频');
    if (this.activity !== 'idle') throw new Error('已有操作在执行');
    this.activity = 'preparing';
    if (!(await this.binaryReady('ffmpeg'))) { this.activity = 'idle'; throw new Error('找不到 ffmpeg，请先安装并加入 PATH'); }
    this.activity = 'transcoding'; this.shouldPause = false; this.stopRequested = false;
    this.note = '开始逐个转码；已完成且验收通过的文件不会重复转码';
    try {
      for (const task of this.project.tasks) {
        if (this.shouldPause) break;
        if (task.status === 'done' || task.status === 'probe_failed' || task.status === 'conflict') continue;
        if (!['pending', 'failed', 'interrupted'].includes(task.status)) continue;
        await this.transcodeOne(task);
      }
      this.note = this.shouldPause ? '队列已停止，可点击“继续转码”重试中断项' : '队列已运行完毕；请查看失败项并执行验收';
    } catch (e) { this.note = `队列异常：${readableError(e)}`; }
    finally { this.runningChild = null; this.activity = 'idle'; this.shouldPause = false; this.stopRequested = false; this.persist(); }
  }
  async binaryReady(bin) { try { await runProgram(bin, ['-version'], 8000); return true; } catch { return false; } }
  async transcodeOne(t) {
    t.progress = 0; t.speed = ''; t.error = ''; t.log = ''; t.startedAt = now(); t.finishedAt = null;
    t.status = 'running'; t.attempts = (t.attempts || 0) + 1; this.persist();
    try {
      await fsp.mkdir(path.dirname(t.output), { recursive: true });
      if (fileExists(t.output)) {
        try { const verification = await checkOutput(t); Object.assign(t, verification, { status: 'done', progress: 100, error: '' }); return; }
        catch (e) { t.status = 'conflict'; t.error = `目标文件已经存在但未通过验收，未覆盖：${readableError(e)}。请手动移走文件后重试。`; return; }
      }
      // A .partial file from interrupted previous run is never trusted; remove it first.
      await fsp.rm(t.temporary, { force: true });
      const { args } = commandFor(t);
      await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        this.runningChild = child; t.pid = child.pid || null; this.persist();
        let settled = false;
        const finish = err => { if (settled) return; settled = true; this.runningChild = null; t.pid = null; err ? reject(err) : resolve(); };
        let tail = ''; let lastPersist = Date.now();
        child.on('error', e => finish(new Error(`无法启动 ffmpeg: ${readableError(e)}`)));
        child.stderr.on('data', data => {
          const str = data.toString();
          tail = (tail + str).slice(-10000);
          t.log = tail.slice(-6000);
          const seconds = parseTime(str);
          if (seconds !== null && t.duration) t.progress = Math.min(99.9, Math.max(0, seconds / t.duration * 100));
          const sp = [...str.matchAll(/speed=\s*([^\s]+)/g)].pop();
          if (sp) t.speed = sp[1];
          if (Date.now() - lastPersist > 2500) { this.persist(); lastPersist = Date.now(); }
        });
        child.on('close', (code, signal) => code === 0 && !this.stopRequested ? finish(null)
          : finish(new Error(this.stopRequested ? '用户停止了当前任务' : `ffmpeg 退出码 ${code}（signal=${signal || '无'}）: ${tail.slice(-1400)}`)));
      });
      Object.assign(t, await checkOutput({ ...t, output: t.temporary }));
      // Do not clobber files that unexpectedly appeared while encoding.
      if (fileExists(t.output)) throw new Error('转码期间目标位置出现了其他文件；停止，避免覆盖');
      await fsp.rename(t.temporary, t.output);
      t.status = 'done'; t.progress = 100; t.error = '';
      t.verifiedAt = now();
    } catch (e) {
      t.status = this.stopRequested ? 'interrupted' : 'failed';
      t.error = readableError(e);
      t.progress = 0;
      // Keep the partial until next retry, for postmortem log / power-loss safety.
    } finally { t.finishedAt = now(); t.pid = null; this.persist(); }
  }
  pause() {
    if (this.activity !== 'transcoding') throw new Error('当前没有转码队列');
    this.shouldPause = true;
    this.note = '将在当前视频转码结束后暂停（不中断当前视频）';
  }
  stop() {
    if (this.activity !== 'transcoding') throw new Error('当前没有转码队列');
    this.shouldPause = true; this.stopRequested = true;
    this.note = '正在停止当前 FFmpeg；未完成的临时文件不会参与验收';
    const child = this.runningChild;
    if (child?.pid) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch {} });
      } else { try { child.kill('SIGTERM'); } catch {} }
    }
  }
  async verify({ deep = false } = {}) {
    if (this.activity !== 'idle') throw new Error('已有操作在执行');
    if (!this.project) throw new Error('请先设置项目');
    this.activity = 'verifying';
    let ok = 0, bad = 0;
    try {
      for (const t of this.project.tasks) {
        if (t.status !== 'done' && t.status !== 'conflict') continue;
        try {
          const result = await checkOutput(t);
          if (deep) await runProgram('ffmpeg', ['-v', 'error', '-i', t.output, '-map', '0:v:0', '-f', 'null', '-'], 24 * 60 * 60 * 1000);
          Object.assign(t, result, { status: 'done', error: '', progress: 100 });
          ok++;
        } catch (e) { t.status = 'failed'; t.error = `验收不通过：${readableError(e)}`; bad++; }
        this.note = `正在${deep ? '完整解码' : 'ffprobe'}验收：通过 ${ok}，不通过 ${bad}`;
        this.persist();
      }
      this.note = `验收结束：通过 ${ok}，失败 ${bad}。可导出验收报告。`;
    } catch (e) { this.note = `验收中止：${readableError(e)}`; }
    finally { this.activity = 'idle'; this.persist(); }
  }
  resetFailed() {
    if (this.activity !== 'idle') throw new Error('已有操作在执行');
    if (!this.project) throw new Error('未配置项目');
    let n = 0;
    for (const t of this.project.tasks) {
      if (t.status === 'failed' || t.status === 'interrupted' || t.status === 'conflict') { t.status = 'pending'; t.error = ''; t.progress = 0; n++; }
    }
    this.note = `已重置 ${n} 个失败／中断／冲突任务；冲突任务仍需先移走现有目标文件。`; this.persist();
  }
  exportCommands() {
    if (!this.project) throw new Error('未配置项目');
    const lines = [`源目录：${this.project.source}`, `孪生输出目录：${this.project.output}`, `扫描时间：${this.project.scanAt || '未扫描'}`, `规则：ffmpeg -i 输入 -c:v libx265 -movflags +faststart -vf scale=宽:高 -c:a copy 输出`, '',
      '说明：转码参数以各文件实际命令为准；输出先写入 *.partial.<扩展名>，验收后原子重命名。', ''];
    let currentDir = null;
    for (const t of this.project.tasks) {
      const dir = path.posix.dirname(t.relative);
      if (dir !== currentDir) { lines.push(`\n[${dir === '.' ? '/' : '/' + dir + '/'}]`); currentDir = dir; }
      lines.push(`  ${t.relative.split('/').pop()}  [${t.status}] ${t.width || '?'}×${t.height || '?'} → ${t.targetWidth || '?'}×${t.targetHeight || '?'}`);
      if (t.command) lines.push('    ' + t.command);
      if (t.error) lines.push(`    错误：${t.error}`);
    }
    return lines.join('\n') + '\n';
  }
  exportCsv() {
    const fields = ['relative','status','width','height','targetWidth','targetHeight','sourceCodec','audioCodec','bytes','outputBytes','duration','attempts','startedAt','finishedAt','verifiedAt','input','output','error'];
    const escape = x => `"${String(x ?? '').replace(/"/g, '""')}"`;
    return '\uFEFF' + fields.join(',') + '\r\n' + (this.project?.tasks || []).map(t => fields.map(k => escape(t[k])).join(',')).join('\r\n') + '\r\n';
  }
}

const manager = new Manager();
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body);
}
function textFile(res, filename, contents, contentType) {
  res.writeHead(200, { 'content-type': contentType, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' }); res.end(contents);
}
function normalizeDir(p) { return path.resolve(p || os.homedir()); }
async function directories(requested) {
  if (process.platform === 'win32' && !requested) {
    const drives = [];
    for (let code = 65; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ':\\';
      if (fs.existsSync(drive)) drives.push({ name: drive, full: drive });
    }
    return { current: '', parent: '', dirs: drives };
  }
  const current = normalizeDir(requested);
  const st = await fsp.stat(current).catch(() => null);
  if (!st?.isDirectory()) throw new Error('该目录不存在或不可访问');
  const children = await fsp.readdir(current, { withFileTypes: true });
  return { current, parent: path.dirname(current) === current ? '' : path.dirname(current),
    dirs: children.filter(x => x.isDirectory() && !x.name.startsWith('.')).map(x => ({ name: x.name, full: path.join(current, x.name) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')) };
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${BIND}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, manager.snapshot());
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/video') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, {error: '禁止跨站预览'});
      return workflow.serveVideo(req, res, url, manager.project);
    }
    if (req.method === 'GET' && url.pathname === '/api/directories') return json(res, 200, await directories(url.searchParams.get('path')));
    if (req.method === 'GET' && url.pathname === '/api/export/commands') return textFile(res, 'ffmpeg-commands.txt', manager.exportCommands(), 'text/plain; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/export/report.csv') return textFile(res, 'h265-720p-report.csv', manager.exportCsv(), 'text/csv; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/export/report.json') return textFile(res, 'h265-720p-report.json', JSON.stringify(manager.snapshot(), null, 2), 'application/json; charset=utf-8');
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      // Local browser only. Forbid cross-origin form/JS requests from arbitrary websites.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${BIND}:${PORT}` && origin !== `http://localhost:${PORT}`) throw new Error('跨站请求已拒绝');
      let raw = '';
      for await (const chunk of req) { raw += chunk.toString(); if (raw.length > MAX_JSON) throw new Error('请求体过大'); }
      const body = raw ? JSON.parse(raw) : {};
      switch (url.pathname) {
        case '/api/config': manager.configure(body); break;
        case '/api/sessions/select': manager.selectSession(body.id); break;
        case '/api/template': manager.saveTemplate(body); break;
        case '/api/template/item': manager.saveItemTemplate(body.id, body.override); break;
        case '/api/scan':
          if (manager.activity !== 'idle') throw new Error('已有操作在执行');
          // Typed but un-applied paths are applied before starting ffprobe.
          if (body.source && (path.resolve(body.source) !== manager.project?.source ||
            (body.output && path.resolve(body.output) !== manager.project?.output))) manager.configure(body);
          if (!manager.project) throw new Error('请先填写并应用源视频目录');
          void manager.scan().catch(e => {manager.activity = 'idle'; manager.note = '扫描失败：' + readableError(e);});
          break;
        case '/api/start': if (manager.activity !== 'idle') throw new Error('已有操作在执行'); void manager.start().catch(e => { manager.activity = 'idle'; manager.note = readableError(e); }); break;
        case '/api/pause': manager.pause(); break;
        case '/api/stop': manager.stop(); break;
        case '/api/retry': manager.resetFailed(); break;
        case '/api/verify': if (manager.activity !== 'idle') throw new Error('已有操作在执行'); void manager.verify({ deep: !!body.deep }); break;
        default: return json(res, 404, { error: '不存在的接口' });
      }
      return json(res, 200, { ok: true, note: manager.note });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持该方法' });
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const p = path.resolve(APP_DIR, 'public', '.' + pathname);
    if (!p.startsWith(path.join(APP_DIR, 'public') + path.sep)) return json(res, 403, { error: '拒绝访问' });
    const stat = await fsp.stat(p).catch(() => null);
    if (!stat?.isFile()) return json(res, 404, { error: '找不到页面' });
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(p).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: readableError(e) });
  }
});

if (require.main === module) {
  server.listen(PORT, BIND, () => {
    console.log(`H.265/720p 批量转码管理器：http://${BIND}:${PORT}`);
    console.log('请用此机器的浏览器访问；服务仅监听本机，不对局域网开放。');
  });
  const close = () => {
    if (manager.runningChild) { manager.stopRequested = true; manager.shouldPause = true;
      try { manager.runningChild.kill('SIGTERM'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
module.exports = { Manager, targetSize, extractMeta, outRelName, commandFor, checkOutput, server, manager };
