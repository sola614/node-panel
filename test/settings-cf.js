'use strict';
/**
 * 备用面板地址与诊断参数的校验测试：node test/settings-cf.js
 *
 * 这里只测纯函数，不起面板、不落库：
 *   - Cloudflare 段判断（判错一个网段，用户就会存进一个「主地址断了它也跟着断」的地址）
 *   - 出口参考点解析（拼进 shell 之前必须只留 host:port）
 *   - 备用地址必须是 origin（带路径会让 agent 拼出 /foo/api/agent/bundle 这种 404）
 */
const path = require('path');
process.env.PANEL_DATA_DIR = process.env.PANEL_DATA_DIR || path.join(require('os').tmpdir(), 'np-settings-cf-' + Date.now());
const s = require('../server/settings');

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

const cf = s.__isCloudflareIp;

console.log('Cloudflare 段判断');
ok('104.21.15.86 是 CF', cf('104.21.15.86') === true);
ok('172.67.161.252 是 CF', cf('172.67.161.252') === true);
ok('104.16.0.0 是 CF（段起点）', cf('104.16.0.0') === true);
ok('104.15.255.255 不是 CF（段前一个）', cf('104.15.255.255') === false);
ok('104.23.255.255 是 CF（/13 覆盖到 104.23）', cf('104.23.255.255') === true);
ok('198.41.128.1 是 CF', cf('198.41.128.1') === true);
ok('8.8.8.8 不是 CF', cf('8.8.8.8') === false);
// 文档示例段不能被误判，否则用户填示例地址都存不进去
ok('203.0.113.10 不是 CF', cf('203.0.113.10') === false);
ok('192.168.1.1 不是 CF', cf('192.168.1.1') === false);
ok('非法输入不抛异常', cf('not-an-ip') === false && cf('') === false);

console.log('\n出口参考点解析');
const p1 = s.__parseProbeList('www.baidu.com:443, github.com:443,8.8.8.8:443');
ok('逗号 + 空格都当分隔符', p1.value === 'www.baidu.com:443,github.com:443,8.8.8.8:443', p1.value);
ok('空串表示不做出口探测', s.__parseProbeList('  ').value === '');
ok('拒绝缺少端口的写法', !!s.__parseProbeList('8.8.8.8').error);
ok('拒绝非法端口', !!s.__parseProbeList('8.8.8.8:70000').error);
ok('拒绝注入字符', !!s.__parseProbeList('8.8.8.8:443;rm -rf /').error);
ok('最多保留 6 个', s.__parseProbeList('a.com:1,b.com:2,c.com:3,d.com:4,e.com:5,f.com:6,g.com:7').value.split(',').length === 6);

console.log('\n备用地址规范化');
ok('裸域名补成 https origin', s.__normalizePanelOrigin('203.0.113.10:8443', '备用面板地址') === 'https://203.0.113.10:8443');
ok('带路径被拒绝', (() => {
  try {
    s.__normalizePanelOrigin('https://panel.example.com/api', '备用面板地址');
    return false;
  } catch {
    return true;
  }
})());
ok('带查询串被拒绝', (() => {
  try {
    s.__normalizePanelOrigin('https://panel.example.com/?x=1', '备用面板地址');
    return false;
  } catch {
    return true;
  }
})());
ok('空串合法（等于不配置）', s.__normalizePanelOrigin('', '备用面板地址') === '');

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
