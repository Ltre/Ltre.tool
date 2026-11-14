(() => {
  'use strict';
  const button = document.getElementById('verify-watchability');
  if (!button) {
    console.error('当前页面没有「验收可观看性」入口。请更新页面后重试。');
    return;
  }
  if (button.disabled) {
    console.warn('当前任务没有可验收的已完成视频，或任务正在执行其他操作。');
    return;
  }
  button.click();
  console.info('已启动集成式可观看性验收；暂停、停止及报告请在页面遮罩层中操作。');
})();