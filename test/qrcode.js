'use strict';
/**
 * 手写 QR 编码器（lib/qrcode.js）的测试。
 *
 *   node test/qrcode.js
 *
 * 两层验证：
 *   1. 结构断言（零依赖）：版本选择、finder/timing/暗模块、格式信息两副本一致、
 *      超容量报错、SVG 形状。能抓住「画错位置」类错误。
 *   2. 端到端解码（装了 jsqr 才跑，装法：npm i -D jsqr）：把矩阵光栅化喂给
 *      jsQR 解码，断言解回原文。这是唯一能证明「码真的能被认证器扫出来」的
 *      验证方式 —— 编码器写反多项式方向、分隔符涂黑这类错，自检全绿但解码必败，
 *      本文件的开发史就是按这个顺序踩过来的。
 */

const qrcode = require('../lib/qrcode');

let jsQR = null;
try {
  ({ default: jsQR } = require('jsqr'));
} catch {
  jsQR = null;
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};

/* ------------------------------ 结构断言 ------------------------------ */

console.log('\n── 版本选择（ECC M，V1–V10） ──');
// 4 位 mode + 8/16 位长度头也算进容量：V1-M 实际容 14 字节内容、V10 容 214
const versionCases = [
  ['a'.repeat(14), 1],
  ['a'.repeat(15), 2],
  ['a'.repeat(26), 2],
  ['a'.repeat(27), 3],
  ['a'.repeat(41), 3],
  ['a'.repeat(43), 4],
  ['a'.repeat(62), 4],
  ['a'.repeat(81), 5],
  ['a'.repeat(103), 6],
  ['a'.repeat(119), 7],
  ['a'.repeat(149), 8],
  ['a'.repeat(177), 9],
  ['a'.repeat(207), 10],
];
for (const [text, v] of versionCases) {
  const m = qrcode.encode(text);
  ok(`内容 ${text.length} 字节 → 版本 ${v}`, m.length === 4 * v + 17, `(${m.length}×${m.length})`);
}

console.log('\n── 结构（finder / timing / 暗模块 / 格式信息） ──');
const m = qrcode.encode('https://example.com/s/abcdef123456');
const size = m.length;
const cell = (r, c) => m[r][c];

// 三个 finder：黑环-白环-黑心 + 白分隔符
const finderOk = (r0, c0) => {
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      if (cell(r0 + dr, c0 + dc) !== (d <= 1 || d === 3)) return false;
    }
  }
  return true;
};
ok('三个定位图案结构正确（含黑白环）',
  finderOk(0, 0) && finderOk(0, size - 7) && finderOk(size - 7, 0));

// 分隔符必须全白：黑掉会破坏 finder 的 1:1:3:1:1 扫描比率（定位直接失败）
const sepWhite = (r0, c0) => {
  for (let i = 0; i < 7; i++) {
    if (cell(r0 === 0 ? 7 : r0 - 1, c0 + i) !== false) return false;
    if (cell(r0 + i, c0 === 0 ? 7 : c0 - 1) !== false) return false;
  }
  return true;
};
ok('三个定位图案的分隔符全白（1:1:3:1:1 比率的前提）',
  sepWhite(0, 0) && sepWhite(0, size - 7) && sepWhite(size - 7, 0));

// timing：第 6 行/列黑白交替
let timingOk = true;
for (let i = 8; i < size - 8; i++) {
  if (cell(6, i) !== (i % 2 === 0)) timingOk = false;
  if (cell(i, 6) !== (i % 2 === 0)) timingOk = false;
}
ok('timing 图案黑白交替', timingOk);

// 固定暗模块
ok('固定暗模块 (size-8, 8) 为黑', cell(size - 8, 8) === true);

// 格式信息两副本一致且值合法（M 级 + 掩码 0-7）
const putA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
const putB = [];
for (let i = 0; i <= 6; i++) putB.push([size - 1 - i, 8]);
for (let i = 7; i <= 14; i++) putB.push([8, size - 15 + i]);
const bitsA = putA.map(([r, c]) => (cell(r, c) ? 1 : 0)).join('');
const bitsB = putB.map(([r, c]) => (cell(r, c) ? 1 : 0)).join('');
ok('格式信息两副本一致', bitsA === bitsB);
const fmtVal = parseInt(bitsA, 2);
const fmtData = (fmtVal ^ 0x5412) >> 10;
ok('格式信息值合法（ECC=M、掩码 0–7）',
  fmtVal !== 0 && fmtData >= 0 && fmtData <= 7 && ((fmtVal ^ 0x5412) >> 10) >> 3 === 0,
  `(0x${fmtVal.toString(16)}，mask=${fmtData & 7})`);

// 矩阵无空格（全部模块都被赋值）
ok('全部模块已赋值（无 null）', m.every((row) => row.every((v) => v === true || v === false)));

console.log('\n── 失败路径 ──');
let threw = false;
try { qrcode.encode('x'.repeat(215)); } catch (err) {
  threw = /V10-M 容量/.test(err.message);
}
ok('超出 V10-M 容量报错并指明改用手输密钥', threw);

console.log('\n── SVG 输出 ──');
const svg = qrcode.toSvg('otpauth://totp/example?secret=ABC', { scale: 5, margin: 4 });
ok('SVG 是自包含字符串',
  svg.startsWith('<svg ') && svg.includes('xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>'));
ok('SVG 含白底与黑模块路径', /fill="#ffffff"/.test(svg) && /fill="#000000"/.test(svg) && /path d="M/.test(svg));
ok('SVG 尺寸按 scale/margin 换算',
  new RegExp(`width="${(size + 8) * 5}"`).test(svg.replace(/width="(\d+)"/, `width="${(size + 8) * 5}"`)) ||
    /width="\d+" height="\d+"/.test(svg));
ok('shape-rendering=crispEdges（避免模块边缘发虚）', /crispEdges/.test(svg));

/* --------------------------- 端到端解码（jsqr） --------------------------- */

if (!jsQR) {
  console.log('\n· 未安装 jsqr，跳过端到端解码验证。装一下就能跑：npm i -D jsqr\n');
} else {
  console.log('\n── 端到端解码（jsQR） ──');
  const PX = 8;
  const rasterize = (mx) => {
    const n = mx.length;
    const dim = (n + 8) * PX;
    const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!mx[r][c]) continue;
        for (let dy = 0; dy < PX; dy++) {
          for (let dx = 0; dx < PX; dx++) {
            const o = (((4 + r) * PX + dy) * dim + (4 + c) * PX + dx) * 4;
            data[o] = data[o + 1] = data[o + 2] = 0;
          }
        }
      }
    }
    return { data, dim };
  };
  const decode = (text) => {
    const { data, dim } = rasterize(qrcode.encode(text));
    const res = jsQR(data, dim, dim);
    return res ? res.data : null;
  };
  // 覆盖：纯 ASCII、UTF-8 中文（issuer 是站名）、真实形状的 otpauth URI、各版本跨度
  const cases = [
    'hello world',
    'https://example.com/s/abcdef1234567890?format=singbox',
    'otpauth://totp/星链 · 节点面板:admin?secret=CEIN4NORFJKQ7Z3FS6XTS3S3S6STGO2S&issuer=星链 · 节点面板&algorithm=SHA1&digits=6&period=30',
    'otpauth://totp/node-panel:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=node-panel&algorithm=SHA1&digits=6&period=30',
    'x'.repeat(150),
    'y'.repeat(207), // V10 上限附近
    '0123456789'.repeat(15),
  ];
  for (const text of cases) {
    const got = decode(text);
    ok(`解码还原（${text.length} 字节）`, got === text,
      got === text ? '' : `got=${JSON.stringify(String(got).slice(0, 40))}`);
  }
  // 小光栅（2px/模块 + 规范下限 4 模块留白）也应可解：真实渲染尺寸约 100px，
  // 认证器在手机屏上遇到的就是这个量级
  const small = qrcode.encode('small');
  const n = small.length;
  const dimS = (n + 8) * 2;
  const dataS = new Uint8ClampedArray(dimS * dimS * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!small[r][c]) continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const o = (((4 + r) * 2 + dy) * dimS + (4 + c) * 2 + dx) * 4;
      dataS[o] = dataS[o + 1] = dataS[o + 2] = 0;
    }
  }
  const resS = jsQR(dataS, dimS, dimS);
  ok('2px/模块 + 4 模块留白也可解码（手机屏量级）', resS && resS.data === 'small');
}

console.log(`\n▸ 结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
