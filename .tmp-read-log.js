'use strict';
const { spawnSync } = require('child_process');
const r = spawnSync('node', ['test/singbox.js'], { encoding: 'utf8', cwd: process.cwd() });
const all = ((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/);
console.log(all.slice(-12).join('\n'));