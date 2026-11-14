'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {compareFrameData, DEFAULTS} = require('../public/watchability-audit');
function frame(makePixel, width = DEFAULTS.width, height = DEFAULTS.height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const [r,g,b] = makePixel(x,y);
      data[offset]=r; data[offset+1]=g; data[offset+2]=b; data[offset+3]=255;
    }
  }
  return data;
}
test('可观看性画面比较：相同帧通过且相似度为 1',()=>{
  const a=frame((x,y)=>[(x*7+y*3)%256,(x*2+y*11)%256,(x*5+y*13)%256]);
  const result=compareFrameData(a,new Uint8ClampedArray(a));
  assert.equal(result.pass,true); assert.equal(result.ssim,1);
  assert.equal(result.lumaMae,0); assert.equal(result.colorMae,0);
});
test('可观看性画面比较：轻微编码噪声允许通过',()=>{
  const a=frame((x,y)=>[40+(x*3+y)%160,30+(y*5)%180,50+(x*7)%150]);
  const b=frame((x,y)=>{
    const [r,g,blue]=[40+(x*3+y)%160,30+(y*5)%180,50+(x*7)%150];
    const noise=((x+y)%3)-1;
    return [r+noise*2,g-noise*2,blue+noise];
  });
  const result=compareFrameData(a,b);
  assert.equal(result.pass,true,JSON.stringify(result));
  assert.ok(result.ssim>0.98,JSON.stringify(result));
});
test('可观看性画面比较：不同画面不能因平均亮度接近而误通过',()=>{
  const a=frame((x,y)=>((x+y)%2?[235,235,235]:[20,20,20]));
  const b=frame((x,y)=>((x+y)%2?[20,20,20]:[235,235,235]));
  const result=compareFrameData(a,b);
  assert.equal(result.pass,false,JSON.stringify(result));
  assert.ok(result.ssim<0.82,JSON.stringify(result));
});
test('可观看性画面比较：色彩错误也会被检测',()=>{
  const a=frame(()=>[230,30,30]), b=frame(()=>[30,30,230]);
  const result=compareFrameData(a,b);
  assert.equal(result.pass,false,JSON.stringify(result));
  assert.ok(result.colorMae>40,JSON.stringify(result));
});
test('可观看性画面比较：拒绝尺寸不匹配的像素数据',()=>{
  assert.throws(()=>compareFrameData(new Uint8Array(8),new Uint8Array(8)),/尺寸不匹配/);
});