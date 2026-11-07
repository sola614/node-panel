'use strict';
/**
 * 端口跳跃的纯函数测试：node test/hop.js
 *
 * 不需要起面板、不需要 root —— 这里测的是「范围字符串怎么解析、三种订阅方言怎么写、
 * agent 到底收没收到范围」这三件最容易写错的事。规则真正下发到 nft 的那部分
 * 在 test/agent.js（假面板）里覆盖，因为那需要一台 Linux。
 */

const assert = require('node:assert');
const hysteria = require('../lib/hysteria');
const sub = require('../lib/sub');
const { buildBundle } = require('../lib/agentBundle');

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
const eq = (name, actual, expected) => ok(name, actual === expected, actual === expected ? '' : `实际 ${JSON.stringify(actual)}`);

/* ------------------------------ 范围解析 ------------------------------ */
console.log('\n范围解析');

const empty = hysteria.parsePortRange('');
ok('空串视为关闭', empty.ok && empty.ranges.length === 0);
ok('undefined 不炸', hysteria.parsePortRange(undefined).ok);

const one = hysteria.parsePortRange('40000-40499');
ok('单段解析', one.ok && one.count === 500 && one.text === '40000-40499');

const multi = hysteria.parsePortRange('41000, 40000-40499');
ok('多段 + 空格', multi.ok && multi.count === 501);
eq('多段按起点排序后规范化', multi.text, '40000-40499,41000');

ok('非数字报错', !hysteria.parsePortRange('abc').ok);
ok('起点大于终点报错', !hysteria.parsePortRange('40499-40000').ok);
ok('低于 1024 报错', !hysteria.parsePortRange('80-100').ok);
ok('含 65535 报错', !hysteria.parsePortRange('65000-65535').ok);
ok('段间重叠报错', !hysteria.parsePortRange('40000-40100,40050-40200').ok);
ok(
  '超过 1000 个端口报错',
  !hysteria.parsePortRange('20000-50000').ok,
  `上限 ${hysteria.HOP_LIMITS.maxPorts}`,
);

/* ---------------------------- 跳变间隔归一 ---------------------------- */
console.log('\n跳变间隔');
eq('默认 30', hysteria.normalizeHopInterval(undefined), 30);
eq('低于 5 抬到 5', hysteria.normalizeHopInterval(1), 5);
eq('高于 600 压到 600', hysteria.normalizeHopInterval(9999), 600);
eq('非法值回默认', hysteria.normalizeHopInterval('abc'), 30);

/* ------------------------------ hopOf -------------------------------- */
console.log('\nhopOf');
const hopNode = {
  protocol: 'hysteria2',
  hy2: { hop: '40000-40499', hopInterval: 45 },
};
const hop = hysteria.hopOf(hopNode);
ok('开跳跃的节点返回范围', hop && hop.count === 500 && hop.interval === 45);
ok('范围为空返回 null', hysteria.hopOf({ protocol: 'hysteria2', hy2: { hop: '' } }) === null);
ok('非 hy2 节点返回 null', hysteria.hopOf({ protocol: 'vless' }) === null);
ok('范围非法返回 null（不抛）', hysteria.hopOf({ protocol: 'hysteria2', hy2: { hop: 'bad' } }) === null);

/* ------------------------------ 订阅方言 ------------------------------ */
console.log('\n订阅三种格式');

const node = {
  id: 'a1b2c3d4e5f6',
  name: 'HK-HY2',
  mode: 'standalone',
  address: '1.2.3.4',
  protocol: 'hysteria2',
  port: 443,
  sni: 'hk.example.com',
  hy2: { obfs: '', obfsPassword: '', upMbps: 100, downMbps: 200, hop: '40000-40499', hopInterval: 30 },
};
const user = { id: 7, uuid: '11111111-1111-1111-1111-111111111111' };

const uri = sub.buildLink(node, [], user, null);
ok('URI 带 mport', /[?&]mport=40000-40499(&|#)/.test(uri), uri.slice(0, 90));
ok('URI 的逗号不被编码成 %2C', !/%2C/i.test(uri));
ok('URI 的 port 位仍是单端口', uri.includes('@1.2.3.4:443?'));

// 中转入口：客户端连的是入口机，落地机的 redirect 规则看不到这批流量
const entry = { id: 'e1', name: '中转', host: 'relay.example.com', port: 8443 };
const uriViaEntry = sub.buildLink(node, [], user, entry);
ok('走中转入口时不下发范围', !/mport=/.test(uriViaEntry), uriViaEntry.split('?')[1] || '');

const clash = sub.toClash([node], [], user, 'site', null, null);
// YAML 里 `40000-40499` 不加引号也是字符串（不是合法数字），mihomo 按 string 收
ok('Clash 带 ports', /ports: ['"]?40000-40499['"]?/.test(clash));
ok('Clash 带 hop-interval', /hop-interval: 30/.test(clash));
ok('Clash 保留 port 做旧内核兜底', /port: 443/.test(clash));

const sb = JSON.parse(sub.toSingBox([node], [], user, 'site', null, null));
const sbHy = sb.outbounds.find((o) => o.type === 'hysteria2');
ok('sing-box 用冒号分段', JSON.stringify(sbHy.server_ports) === '["40000:40499"]', JSON.stringify(sbHy.server_ports));
eq('sing-box 间隔带单位', sbHy.hop_interval, '30s');
ok('sing-box 保留 server_port', sbHy.server_port === 443);

// 关掉跳跃后，三种格式都不该再出现跳跃字段
const plain = { ...node, hy2: { ...node.hy2, hop: '' } };
ok('关闭后 URI 无 mport', !/mport=/.test(sub.buildLink(plain, [], user, null)));
ok('关闭后 Clash 无 ports 字段', !/^\s+ports:/m.test(sub.toClash([plain], [], user, 'site', null, null)));
const sbPlain = JSON.parse(sub.toSingBox([plain], [], user, 'site', null, null)).outbounds.find(
  (o) => o.type === 'hysteria2',
);
ok('关闭后 sing-box 无 server_ports', !sbPlain.server_ports && !sbPlain.hop_interval);

/* ---------------------------- 配置包下发 ---------------------------- */
console.log('\n配置包下发');

const payload = {
  hash: 'deadbeefdeadbeef',
  scope: { type: 'server', id: 's1', name: 'HK' },
  agentVersion: '0.1.29',
  userCount: 1,
  xray: null,
  nodes: [
    { id: 'a1b2c3d4e5f6', name: 'HK-HY2', protocol: 'hysteria2', port: 443 },
    { id: 'b2c3d4e5f6a1', name: 'JP-HY2', protocol: 'hysteria2', port: 8443 },
    { id: 'c3d4e5f6a1b2', name: 'SG-HY2', protocol: 'hysteria2', port: 2053 },
  ],
  hysteria: [
    { nodeId: 'a1b2c3d4e5f6', port: 443, statsPort: 29000, secret: 's1', yaml: 'a', hop: '40000-40499' },
    { nodeId: 'b2c3d4e5f6a1', port: 8443, statsPort: 29001, secret: 's2', yaml: 'b', hop: '40500-40999' },
    // 没开跳跃的节点不该出现在 NP_HY_HOP 里
    { nodeId: 'c3d4e5f6a1b2', port: 2053, statsPort: 29002, secret: 's3', yaml: 'c', hop: '' },
  ],
  certs: [],
};
const bundle = buildBundle(payload, { panelUrl: 'http://127.0.0.1:8080', siteName: 'test' });
ok(
  'bundle 下发 NP_HY_HOP',
  /NP_HY_HOP='node-a1b2c3d4e5f6:443:40000-40499 node-b2c3d4e5f6a1:8443:40500-40999'/.test(bundle),
  (bundle.match(/NP_HY_HOP=.*/) || [''])[0],
);
ok('没开跳跃的节点不占位', !bundle.includes('node-c3d4e5f6a1b2:2053:'));
ok('监听端口清单仍是单端口', /NP_LISTEN_PORTS='udp:443 udp:8443 udp:2053'/.test(bundle));

const bundleNoHop = buildBundle(
  { ...payload, hysteria: payload.hysteria.map((h) => ({ ...h, hop: '' })) },
  { panelUrl: 'http://127.0.0.1:8080', siteName: 'test' },
);
ok('全关时 NP_HY_HOP 为空', /NP_HY_HOP=''/.test(bundleNoHop));

/* -------------------------------- 汇总 -------------------------------- */
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
