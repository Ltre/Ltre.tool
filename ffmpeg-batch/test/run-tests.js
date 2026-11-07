'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-batch-tests-'));
let status = 1;
try {
  const files = process.argv.slice(2);
  const args = ['--test', '--test-concurrency=1', ...files];
  const result = spawnSync(process.execPath, args, {
    cwd:path.join(__dirname,'..'),
    env:{...process.env, FFMPEG_BATCH_DATA_DIR:temp},
    stdio:'inherit'
  });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  fs.rmSync(temp, {recursive:true, force:true});
}
process.exitCode = status;
