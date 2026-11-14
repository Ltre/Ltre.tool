'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WatchabilityAudit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULTS = Object.freeze({
    width: 96, height: 54, blockSize: 8, minSsim: 0.82,
    maxLumaMae: 36, maxColorMae: 44, aspectRatioTolerance: 0.02
  });
  function luma(data, offset) {
    return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
  }
  function compareFrameData(left, right, options = {}) {
    const width = options.width || DEFAULTS.width;
    const height = options.height || DEFAULTS.height;
    const blockSize = options.blockSize || DEFAULTS.blockSize;
    const expectedLength = width * height * 4;
    if (!left || !right || left.length !== expectedLength || right.length !== expectedLength) {
      throw new Error('画面数据尺寸不匹配，期望 ' + width + '×' + height + ' RGBA');
    }
    let lumaDiff = 0, colorDiff = 0;
    const pixels = width * height;
    for (let p = 0, offset = 0; p < pixels; p++, offset += 4) {
      lumaDiff += Math.abs(luma(left, offset) - luma(right, offset));
      colorDiff += Math.abs(left[offset] - right[offset]) +
        Math.abs(left[offset + 1] - right[offset + 1]) +
        Math.abs(left[offset + 2] - right[offset + 2]);
    }
    const lumaMae = lumaDiff / pixels;
    const colorMae = colorDiff / (pixels * 3);
    // Local SSIM blocks preserve spatial structure; a global histogram alone
    // could accept a different frame with similar average colors.
    const c1 = 6.5025, c2 = 58.5225;
    let ssimTotal = 0, blockCount = 0;
    for (let top = 0; top < height; top += blockSize) {
      for (let leftEdge = 0; leftEdge < width; leftEdge += blockSize) {
        const bottom = Math.min(height, top + blockSize);
        const rightEdge = Math.min(width, leftEdge + blockSize);
        let sumA = 0, sumB = 0, n = 0;
        for (let y = top; y < bottom; y++) {
          for (let x = leftEdge; x < rightEdge; x++) {
            const offset = (y * width + x) * 4;
            sumA += luma(left, offset); sumB += luma(right, offset); n++;
          }
        }
        const meanA = sumA / n, meanB = sumB / n;
        let varianceA = 0, varianceB = 0, covariance = 0;
        for (let y = top; y < bottom; y++) {
          for (let x = leftEdge; x < rightEdge; x++) {
            const offset = (y * width + x) * 4;
            const da = luma(left, offset) - meanA;
            const db = luma(right, offset) - meanB;
            varianceA += da * da; varianceB += db * db; covariance += da * db;
          }
        }
        varianceA /= n; varianceB /= n; covariance /= n;
        const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
        const denominator = (meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2);
        ssimTotal += denominator ? numerator / denominator : 1;
        blockCount++;
      }
    }
    const ssim = ssimTotal / Math.max(1, blockCount);
    const pass = ssim >= (options.minSsim ?? DEFAULTS.minSsim) &&
      lumaMae <= (options.maxLumaMae ?? DEFAULTS.maxLumaMae) &&
      colorMae <= (options.maxColorMae ?? DEFAULTS.maxColorMae);
    return {
      similarity: Number(ssim.toFixed(4)), ssim: Number(ssim.toFixed(4)),
      lumaMae: Number(lumaMae.toFixed(2)), colorMae: Number(colorMae.toFixed(2)), pass
    };
  }
  function createVideoComparator(options = {}) {
    if (typeof document === 'undefined') throw new Error('视频画面对比必须在浏览器中运行');
    const settings = {...DEFAULTS, ...options};
    const makeSurface = () => {
      const canvas = document.createElement('canvas');
      canvas.width = settings.width; canvas.height = settings.height;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      if (!context) throw new Error('浏览器无法创建 Canvas 画面读取环境');
      return {canvas, context};
    };
    const leftSurface = makeSurface(), rightSurface = makeSurface();
    function capture(video, surface) {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        throw new Error('视频当前没有可读取的画面帧');
      }
      const width = settings.width, height = settings.height;
      const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
      const drawWidth = video.videoWidth * scale, drawHeight = video.videoHeight * scale;
      const x = (width - drawWidth) / 2, y = (height - drawHeight) / 2;
      surface.context.fillStyle = '#101010';
      surface.context.fillRect(0, 0, width, height);
      surface.context.drawImage(video, x, y, drawWidth, drawHeight);
      return surface.context.getImageData(0, 0, width, height).data;
    }
    function captureFrame(video) {
      const surface=makeSurface();
      const data=new Uint8ClampedArray(capture(video,surface));
      surface.canvas.width=0;surface.canvas.height=0;
      return data;
    }
    return {
      captureFrame,
      compareFrames(leftFrame,rightFrame) { return compareFrameData(leftFrame,rightFrame,settings); },
      compare(source, output) {
        const sourceRatio = source.videoWidth / source.videoHeight;
        const outputRatio = output.videoWidth / output.videoHeight;
        const ratioDelta = Math.abs(sourceRatio - outputRatio) / Math.max(sourceRatio, outputRatio);
        if (!Number.isFinite(ratioDelta) || ratioDelta > settings.aspectRatioTolerance) {
          return {similarity:0,ssim:0,lumaMae:255,colorMae:255,pass:false,
            reason:'原视频与结果视频的画面宽高比不一致'};
        }
        return compareFrameData(capture(source,leftSurface),capture(output,rightSurface),settings);
      },
      dispose() {
        leftSurface.canvas.width = 0; leftSurface.canvas.height = 0;
        rightSurface.canvas.width = 0; rightSurface.canvas.height = 0;
      }
    };
  }
  return {DEFAULTS, compareFrameData, createVideoComparator};
});