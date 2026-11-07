const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {targetSize, outRelName, extractMeta, commandFor} = require('../server');
test('1920x1080 → 1280x720', () => assert.deepEqual(targetSize(1920,1080), {width:1280,height:720}));
test('920x1080 → 614x720，保持纵向比例', () => assert.deepEqual(targetSize(920,1080), {width:614,height:720}));
test('竖屏 1080x1920 → 406x720', () => assert.deepEqual(targetSize(1080,1920), {width:406,height:720}));
test('4:3 视频 → 960x720', () => assert.deepEqual(targetSize(1440,1080), {width:960,height:720}));
test('不放大已经小于 720p 的视频', () => assert.deepEqual(targetSize(640,360), {width:640,height:360}));
test('奇数尺寸不会出现任一方向的放大', () => assert.deepEqual(targetSize(321,241), {width:320,height:240}));
test('不兼容容器改用 mkv，保留原扩展名作为防碰撞标识', () => {
 assert.equal(outRelName('dir/foo.webm'),'dir/foo.webm.mkv');
 assert.equal(outRelName('dir/foo.mp4'),'dir/foo.mp4');
 assert.equal(outRelName('dir/foo.mkv'),'dir/foo.mkv');
 assert.equal(outRelName('dir/foo.m4v'),'dir/foo.m4v.mkv');
});
test('旋转 90 度的视频按照实际显示尺寸计算', () => {
 const meta = extractMeta({streams:[{codec_type:'video',width:1080,height:1920,codec_name:'h264',side_data_list:[{rotation:-90}]},{codec_type:'audio',codec_name:'aac'}], format:{duration:'60'}});
 assert.equal(meta.width,1920); assert.equal(meta.height,1080); assert.equal(meta.audioCodec,'aac');
});
test('FFmpeg 参数顺序严格匹配用户指定格式', () => {
 const input = path.resolve('video source.mp4');
 const out = path.resolve('video output.partial.mp4');
 const task = {input, temporary:out, targetWidth:1280,targetHeight:720};
 const cmd = commandFor(task);
 assert.deepEqual(cmd.args, ['-i',input,'-c:v','libx265','-movflags','+faststart','-vf','scale=1280:720','-c:a','copy',out]);
});
