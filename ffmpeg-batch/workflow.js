'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const LEGACY = Object.freeze({videoCodec: 'libx265', scaleMode: 'fit720', percent: 100, crf: ''});
const EMPTY = Object.freeze({videoCodec: '', scaleMode: 'none', percent: 100, crf: ''});
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function normalizeFraction(input) {
  const match = /^\s*(\d{1,12})\s*\/\s*(\d{1,12})\s*$/.exec(String(input ?? ''));
  if (!match) throw new Error('分数请输入正整数分子/正整数分母，例如 720/1080 或 2/3');
  const numerator = BigInt(match[1]), denominator = BigInt(match[2]);
  if (!numerator || !denominator) throw new Error('分数的分子和分母必须大于 0');
  const divisor = gcd(numerator, denominator);
  return `${numerator / divisor}/${denominator / divisor}`;
}
function roundEvenRatio(value, numerator, denominator) {
  // Exact half-up rounding to the nearest even integer; no binary float division.
  const result = ((BigInt(value) * numerator + denominator) / (denominator * 2n)) * 2n;
  if (result < 2n || result > 16384n) throw new Error('目标尺寸必须在 2～16384 像素范围内');
  return Number(result);
}
function normalizeTemplate(input = {}, allowExact = false, allowLegacy = false) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new Error('模板必须是对象');
  const videoCodec = String(input.videoCodec ?? '').trim();
  if (videoCodec && !/^[a-zA-Z0-9_.-]{1,64}$/.test(videoCodec)) throw new Error('视频编码器名称不合法');
  const scaleMode = String(input.scaleMode ?? 'none');
  if (!['none', 'percent', 'fraction', 'shortEdge', ...(allowExact ? ['exact'] : []), ...(allowLegacy ? ['fit720'] : [])].includes(scaleMode)) throw new Error('不支持的缩放模式');
  const percent = Number(input.percent ?? 100);
  if (!Number.isFinite(percent) || percent < 1 || percent > 1000) throw new Error('缩放比例必须在 1%～1000% 之间');
  const crf = input.crf == null || String(input.crf).trim() === '' ? '' : String(input.crf).trim();
  if (crf && (!/^(?:\d+(?:\.\d+)?)$/.test(crf) || Number(crf) > 63)) throw new Error('CRF 必须为 0～63 之间的数值');
  const result = {videoCodec, scaleMode, percent, crf};
  if (scaleMode === 'fraction') result.fraction = normalizeFraction(input.fraction);
  if (scaleMode === 'shortEdge') {
    const shortEdge = Number(input.shortEdge);
    if (!Number.isSafeInteger(shortEdge) || shortEdge < 2 || shortEdge > 16384) throw new Error('目标短边必须为 2～16384 的整数');
    result.shortEdge = shortEdge;
  }
  if (scaleMode === 'exact') {
    const width = Number(input.width), height = Number(input.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 || width > 16384 || height > 16384) {
      throw new Error('指定尺寸必须是 2～16384 的整数');
    }
    result.width = width; result.height = height;
  }
  if (videoCodec === 'copy' && scaleMode !== 'none') throw new Error('视频流复制无法同时使用缩放滤镜');
  if (videoCodec === 'copy' && crf) throw new Error('视频流复制无法使用 CRF 质量参数');
  return result;
}
function ensureTemplateLibrary(project) {
  if (!project) return;
  if (!Array.isArray(project.templates) || !project.templates.length) {
    project.templates = [{id:'default',name:'默认模板',
      template:normalizeTemplate(project.template || LEGACY, false, true)}];
    project.globalTemplateId = 'default';
  }
  if (!project.templates.some(t => t.id === project.globalTemplateId)) project.globalTemplateId = project.templates[0].id;
  project.template = project.templates.find(t => t.id === project.globalTemplateId).template;
  for (const task of project.tasks || []) {
    if (!task.templateScope) task.templateScope = task.override ? 'independent' : 'global';
  }
}
function effectiveTemplate(project, task) {
  if (task?.templateScope === 'independent' || (!task?.templateScope && task?.override)) {
    return normalizeTemplate(task.override || EMPTY, true, true);
  }
  if (task?.templateScope === 'local') {
    const entry = project?.templates?.find(t => t.id === task.localTemplateId);
    if (!entry) throw new Error('单文件引用的局部模板不存在，请重新指定模板');
    return normalizeTemplate(entry.template, true, true);
  }
  const entry = project?.templates?.find(t => t.id === project.globalTemplateId);
  return normalizeTemplate(entry?.template || project?.template || EMPTY, true, true);
}
function calculateTarget(meta, template, fit720) {
  if (!(meta.width > 0 && meta.height > 0)) throw new Error('无效源分辨率');
  switch (template.scaleMode) {
    case 'fit720': return fit720(meta.width, meta.height);
    case 'exact': return {width: template.width, height: template.height};
    case 'fraction': {
      const [a,b] = template.fraction.split('/').map(BigInt);
      return {width: roundEvenRatio(meta.width, a, b), height: roundEvenRatio(meta.height, a, b)};
    }
    case 'shortEdge': {
      const short = Math.min(meta.width, meta.height);
      // An unchanged short edge needs no filter; keep even an odd long edge exact.
      if (short === template.shortEdge) return {width: meta.width, height: meta.height};
      const scale = BigInt(template.shortEdge), base = BigInt(short);
      // The user-specified short edge remains exact, including odd pixel values.
      return {width: meta.width === short ? template.shortEdge : roundEvenRatio(meta.width, scale, base),
        height: meta.height === short ? template.shortEdge : roundEvenRatio(meta.height, scale, base)};
    }
    case 'percent': {
      const even = value => Math.max(2, Math.round(value / 2) * 2);
      return {width: even(meta.width * template.percent / 100), height: even(meta.height * template.percent / 100)};
    }
    default: return {width: meta.width, height: meta.height};
  }
}
function commandArgs(t) {
  const template = normalizeTemplate(t.template || LEGACY, true, true);
  const args = ['-i', t.input];
  if (template.videoCodec) args.push('-c:v', template.videoCodec);
  args.push('-movflags', '+faststart');
  const unchangedShortEdge = template.scaleMode === 'shortEdge' &&
    Number.isFinite(t.width) && Number.isFinite(t.height) &&
    Math.min(t.width, t.height) === template.shortEdge;
  if (template.scaleMode !== 'none' && !unchangedShortEdge) args.push('-vf', `scale=${t.targetWidth}:${t.targetHeight}`);
  if (template.crf) args.push('-crf', template.crf);
  args.push('-c:a', 'copy', t.temporary);
  return args;
}
function outputSizeComparison(t) {
  if (t.status !== 'done' || !Number.isSafeInteger(t.bytes) || t.bytes <= 0 ||
      !Number.isSafeInteger(t.outputBytes) || t.outputBytes <= 0) {
    return {outputLarger: false, sizeDeltaBytes: null};
  }
  const sizeDeltaBytes = t.outputBytes - t.bytes;
  return {outputLarger: sizeDeltaBytes > 0, sizeDeltaBytes};
}
function expectedCodec(t) {
  const codec = (t.template || LEGACY).videoCodec;
  return ({libx265: 'hevc', hevc_nvenc: 'hevc', libx264: 'h264', h264_nvenc: 'h264', libsvtav1: 'av1', libaom_av1: 'av1', libvpx_vp9: 'vp9'})[codec] || (codec === 'copy' ? t.sourceCodec : null);
}
function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
const TYPES = {'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.ts':'video/mp2t','.m2ts':'video/mp2t','.mts':'video/mp2t','.wmv':'video/x-ms-wmv','.flv':'video/x-flv','.mpeg':'video/mpeg','.mpg':'video/mpeg','.3gp':'video/3gpp','.vob':'video/mpeg'};
async function serveVideo(req, res, url, project) {
  const side = url.searchParams.get('side');
  const id = url.searchParams.get('id');
  const task = project?.tasks?.find(t => t.id === id);
  if (!task || !['source','output'].includes(side) || (side === 'output' && task.status !== 'done')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const root = side === 'source' ? project.source : project.output;
  const requested = side === 'source' ? task.input : task.output;
  let realRoot, realFile, stat;
  try {
    realRoot = await fsp.realpath(root);
    realFile = await fsp.realpath(requested);
    if (!within(realRoot, realFile)) throw new Error('Path escapes task root');
    stat = await fsp.stat(realFile);
    if (!stat.isFile() || stat.size === 0) throw new Error('Not a video');
  } catch {
    res.writeHead(404); res.end('Not found'); return;
  }
  const rawRange = req.headers.range;
  let start = 0, end = stat.size - 1, partial = false;
  if (rawRange) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, {'content-range': `bytes */${stat.size}`}); res.end(); return;
    }
    if (match[1]) {
      start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
    } else {
      const length = Number(match[2]);
      if (length <= 0) {res.writeHead(416, {'content-range': `bytes */${stat.size}`}); res.end(); return;}
      start = Math.max(0, stat.size - length);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
      res.writeHead(416, {'content-range': `bytes */${stat.size}`}); res.end(); return;
    }
    end = Math.min(end, stat.size - 1); partial = true;
  }
  const headers = {'content-type': TYPES[path.extname(realFile).toLowerCase()] || 'application/octet-stream',
    'content-length': end - start + 1, 'accept-ranges':'bytes', 'cache-control':'no-store',
    'x-content-type-options':'nosniff', 'content-disposition':'inline'};
  if (partial) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') {res.end(); return;}
  const stream = fs.createReadStream(realFile, {start,end});
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
module.exports = {LEGACY, EMPTY, normalizeTemplate, normalizeFraction, ensureTemplateLibrary, effectiveTemplate, calculateTarget, commandArgs, outputSizeComparison, expectedCodec, serveVideo, within};
