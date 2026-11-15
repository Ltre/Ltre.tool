(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WatchabilityAudit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULTS = Object.freeze({
    points:10, playMs:1200, minAdvanceSeconds:0.25, minPresentedFrames:2,
    readyTimeoutMs:15000, seekTimeoutMs:8000
  });
  function verdict(status, reason) { return {status,reason:reason || ''}; }
  function evaluatePlaybackSample(sample = {}, options = {}) {
    const code = Number(sample.errorCode) || 0;
    if (code === 3) return verdict('FAIL','结果视频发生解码错误');
    if (code === 2) return verdict('UNVERIFIED','读取视频时发生网络或 I/O 错误，无法区分文件问题与读取环境问题');
    if (code === 4) return verdict('UNVERIFIED','当前浏览器不支持此视频编码或容器，不能据此认定文件损坏');
    if (code === 1) return verdict('UNVERIFIED','媒体加载被中止，未取得有效播放证据');
    if (!sample.ready) return verdict('UNVERIFIED','结果视频未能在等待期限内完成加载和解码准备');
    if (sample.seekCompleted === false) return verdict('UNVERIFIED','浏览器未能稳定定位到该检测位置');
    if (sample.playError || sample.playResolved === false) {
      return verdict('UNVERIFIED','浏览器未能启动播放' + (sample.playError ? '：' + sample.playError : ''));
    }
    if (!sample.playbackCompleted) return verdict('UNVERIFIED','检测窗口内未能完成连续播放');
    const advance = Number(sample.advance);
    const minAdvance = Number.isFinite(sample.minAdvanceSeconds)
      ? sample.minAdvanceSeconds
      : Number.isFinite(options.minAdvanceSeconds) ? options.minAdvanceSeconds : DEFAULTS.minAdvanceSeconds;
    if (!Number.isFinite(advance) || advance < minAdvance) {
      return verdict('UNVERIFIED','播放时间轴推进不足（实际 ' +
        (Number.isFinite(advance) ? advance.toFixed(2) : '—') + ' 秒）');
    }
    const minFrames = Number.isFinite(sample.minPresentedFrames)
      ? sample.minPresentedFrames
      : Number.isFinite(options.minPresentedFrames) ? options.minPresentedFrames : DEFAULTS.minPresentedFrames;
    if (sample.frameCallbackSupported && Number(sample.presentedFrames) < minFrames) {
      return verdict('UNVERIFIED','未取得足够的实际呈现帧（' + (Number(sample.presentedFrames) || 0) + ' 帧）');
    }
    return verdict('PASS');
  }
  function summarizePlayback(points, stopped = false) {
    if (stopped) return 'INCOMPLETE';
    const samples = Array.isArray(points) ? points : [];
    if (samples.some(point => point.status === 'FAIL')) return 'FAIL';
    if (samples.some(point => point.status === 'UNVERIFIED')) return 'UNVERIFIED';
    if (samples.length && samples.every(point => point.status === 'PASS')) return 'PASS';
    return 'INCOMPLETE';
  }
  return {DEFAULTS,evaluatePlaybackSample,summarizePlayback};
});