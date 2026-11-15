'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {DEFAULTS,evaluatePlaybackSample,summarizePlayback} = require('../public/watchability-audit');

const playable = {
  errorCode:0, ready:true, seekCompleted:true, playResolved:true,
  playbackCompleted:true, advance:1.18, presentedFrames:28,
  frameCallbackSupported:true
};

test('结果视频正常加载、连续播放并呈现视频帧时通过', () => {
  assert.deepEqual(evaluatePlaybackSample(playable,DEFAULTS),{status:'PASS',reason:''});
});
test('明确的视频解码错误判定失败', () => {
  const result = evaluatePlaybackSample({...playable,errorCode:3},DEFAULTS);
  assert.equal(result.status,'FAIL');
  assert.match(result.reason,/解码错误/);
});
test('浏览器不支持编码时无法判定，不误报文件损坏', () => {
  const result = evaluatePlaybackSample({...playable,errorCode:4},DEFAULTS);
  assert.equal(result.status,'UNVERIFIED');
  assert.match(result.reason,/不支持/);
});
test('网络或 I/O 读取异常无法判定', () => {
  const result = evaluatePlaybackSample({...playable,errorCode:2},DEFAULTS);
  assert.equal(result.status,'UNVERIFIED');
  assert.match(result.reason,/I.?O/);
});
test('播放时间轴推进不足时无法判定', () => {
  const result = evaluatePlaybackSample({...playable,advance:0.12},DEFAULTS);
  assert.equal(result.status,'UNVERIFIED');
  assert.match(result.reason,/推进不足/);
});
test('浏览器未呈现足够视频帧时无法判定', () => {
  const result = evaluatePlaybackSample({...playable,presentedFrames:1},DEFAULTS);
  assert.equal(result.status,'UNVERIFIED');
  assert.match(result.reason,/呈现帧/);
});
test('短暂缓冲后仍有实际播放推进时通过，不因启动延迟误判', () => {
  const result = evaluatePlaybackSample({...playable,advance:0.4,presentedFrames:8},DEFAULTS);
  assert.equal(result.status,'PASS');
});
test('播放推进低于最低阈值时仍无法判定', () => {
  const result = evaluatePlaybackSample({...playable,advance:0.2,presentedFrames:2},DEFAULTS);
  assert.equal(result.status,'UNVERIFIED');
});
test('浏览器不支持帧回调时以播放时间轴作为后备证据', () => {
  const result = evaluatePlaybackSample({...playable,frameCallbackSupported:false,presentedFrames:0},DEFAULTS);
  assert.equal(result.status,'PASS');
});
test('单个视频汇总优先级为失败、无法判定、通过及未完成', () => {
  assert.equal(summarizePlayback([{status:'PASS'},{status:'PASS'}]),'PASS');
  assert.equal(summarizePlayback([{status:'PASS'},{status:'UNVERIFIED'}]),'UNVERIFIED');
  assert.equal(summarizePlayback([{status:'PASS'},{status:'FAIL'}]),'FAIL');
  assert.equal(summarizePlayback([{status:'PASS'},{status:'INCOMPLETE'}]),'INCOMPLETE');
  assert.equal(summarizePlayback([{status:'PASS'}],true),'INCOMPLETE');
});