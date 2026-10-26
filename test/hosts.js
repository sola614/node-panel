'use strict';
/**
 * 域名校验共享模块测试：node test/hosts.js
 *
 * js/hosts.js 是前后端共用的唯一实现 —— 浏览器走 <script> 挂全局 Hosts，
 * 服务端走 require。这里把两条加载路径都跑一遍，用同一批用例断言行为一致：
 * 任何一侧「悄悄改出分叉」（比如有人只改了 require 路径下的副本）都会在这里变红。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'hosts.js'), 'utf8');

// 路径一：Node require（server.js 的用法）
const nodeSide = require('../public/js/hosts');

// 路径二：浏览器经典脚本。vm 新 context 里没有 module / self / window，
// UMD 会退到 this 挂载 —— 等价于 <script> 标签里的行为。
const sandbox = { URL };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);
const browserSide = sandbox.Hosts;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

console.log('域名校验共享模块（两条加载路径行为必须一致）');

// ---- 两侧导出的形状一致 ----
for (const fn of ['isHostName', 'rawHostOf', 'isValidHost']) {
  ok(`两侧都导出 ${fn}`, typeof nodeSide[fn] === 'function' && typeof browserSide[fn] === 'function');
}
ok(
  '两侧 IPV4_RE / HOST_LABEL_RE 定义一致',
  String(nodeSide.IPV4_RE) === String(browserSide.IPV4_RE)
    && String(nodeSide.HOST_LABEL_RE) === String(browserSide.HOST_LABEL_RE),
);

// ---- isHostName 用例：[输入, 期望] ----
const HOST_CASES = [
  ['sub.example.com', true],
  ['example.com', true],
  ['EXAMPLE.CO.UK', true], // 大小写不敏感
  ['a-b.example.com', true],
  ['xn--fiqs8s.cn', true], // punycode TLD
  ['192.168.1.1', true],
  ['[2001:db8::1]', true],
  ['[::1]', true],
  ['', false],
  ['111', false], // 单段数字不是域名（也不是合法 IPv4）
  ['abc', false], // 至少两段
  ['999.1.1.1', false], // 越界 IPv4
  ['1.2.3.4.5', false], // 五段
  ['-bad.example.com', false], // label 不能以 - 开头
  ['bad-.example.com', false], // label 不能以 - 结尾
  ['under_score.example.com', false], // label 不允许下划线
  ['exa mple.com', false], // 空格
  ['a.'.repeat(122) + 'example.com', false], // 总长 255，超 253 上限
  ['example.com.', false], // 尾点在这里不剥（由 rawHostOf/isValidHost 负责）
];

for (const [input, expected] of HOST_CASES) {
  const n = nodeSide.isHostName(input);
  const b = browserSide.isHostName(input);
  ok(`isHostName(${JSON.stringify(input)}) = ${expected}`, n === expected && b === expected);
}

// ---- rawHostOf 用例：从原始文本抠主机名 ----
const RAW_CASES = [
  ['https://user:pass@host.example.com:8443/path?q=1', 'host.example.com'],
  ['host.example.com:8443', 'host.example.com'],
  ['http://[2001:db8::1]:8080/x', '[2001:db8::1]'],
  ['ftp://files.example.com/pub', 'files.example.com'],
  ['example.com.', 'example.com'], // 尾点剥掉
  ['plainhost', 'plainhost'],
];

for (const [input, expected] of RAW_CASES) {
  const n = nodeSide.rawHostOf(input);
  const b = browserSide.rawHostOf(input);
  ok(`rawHostOf(${JSON.stringify(input)}) = ${JSON.stringify(expected)}`, n === expected && b === expected);
}

// ---- isValidHost 用例：防「URL 把 111 解析成 0.0.0.111」的那层 ----
const VALID_CASES = [
  ['111', '0.0.0.111', false], // 数字写法必须回到原文严格校验
  ['192.168.1.1', '192.168.1.1', true],
  ['sub.example.com', 'sub.example.com', true],
  ['sub.example.com.', 'sub.example.com', true], // 尾点容忍
];

for (const [raw, normalized, expected] of VALID_CASES) {
  const n = nodeSide.isValidHost(raw, normalized);
  const b = browserSide.isValidHost(raw, normalized);
  ok(`isValidHost(${JSON.stringify(raw)}) = ${expected}`, n === expected && b === expected);
}

console.log(`\n${fail ? '✗ ' + fail + ' 项失败' : '全部通过'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
