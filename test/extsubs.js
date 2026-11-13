'use strict';
/**
 * 外部订阅合并 + 节点级凭证测试。
 *
 * server/extsubs.js 的拉取/缓存需要网络与 store，不在纯函数测试范围；
 * 这里锁住合并链路的核心语义（lib/sub.js 的凭证覆盖 + 订阅生成器的混合输出）：
 *   - 自建节点：凭证始终是面板用户 UUID（credential=null 回落）
 *   - 分享导入 / 外部订阅节点：凭证用 node.credential（分享者给的）
 *   - 三种订阅方言（Base64 / Clash / sing-box）口径一致
 */

const sub = require('../lib/sub');
const { parseShareLink } = require('../lib/parse-link');

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

const USER = { id: 'u1', uuid: '11111111-panel-user-uuid', name: 'tester', planId: null };
const SERVERS = [];

/** 模拟 server/extsubs.js toExtNode 的虚拟节点形状：parse-link 草稿 + 固定补齐 */
function extNode(uri, i) {
  const d = parseShareLink(uri);
  if (!d.ok) throw new Error('测试用链接解析失败: ' + d.error);
  const n = d.node;
  return {
    id: `ext-ext1-${i}`,
    mode: 'imported',
    imported: true,
    ext: true,
    name: n.name,
    protocol: n.protocol,
    address: n.address,
    port: n.port,
    network: n.network || 'tcp',
    path: n.path || '',
    host: n.host || '',
    security: n.security || 'none',
    sni: n.sni || '',
    fp: n.fp || '',
    method: n.method || '',
    password: n.password || '',
    vlessEncryption: !!n.vlessEncryption,
    reality: n.reality || null,
    hy2: n.hy2 || null,
    credential: n.credential || null,
    insecure: !!n.insecure,
    certFingerprint: n.certFingerprint || '',
    entries: [],
    planIds: [],
    hidden: false,
    enabled: true,
  };
}

/** 自建节点（无 credential）：跟随服务器模式的最小形状 */
function ownNode(over = {}) {
  return {
    id: 'own1',
    mode: 'server',
    serverId: '',
    name: '自建节点',
    protocol: 'vless',
    address: 'own.example.com',
    port: 443,
    network: 'tcp',
    path: '',
    host: '',
    security: 'reality',
    sni: 'www.apple.com',
    fp: 'chrome',
    vlessEncryption: false,
    reality: { dest: 'www.apple.com:443', serverNames: 'www.apple.com', privateKey: '', publicKey: 'own-pbk', shortId: 'abcd1234', flow: 'xtls-rprx-vision', strictMode: false },
    hy2: null,
    credential: null,
    insecure: false,
    certFingerprint: '',
    entries: [],
    planIds: [],
    hidden: false,
    enabled: true,
    imported: false,
    ...over,
  };
}

const SHARE_VLESS = extNode(
  'vless://share-uuid-9999@hk.shared.example.com:443?security=reality&sni=www.apple.com&fp=chrome&pbk=share-pbk&sid=6ba85179&type=tcp&flow=xtls-rprx-vision#%E5%90%88%E7%A7%9FHK',
  0,
);
const SHARE_HY2 = extNode('hysteria2://share-hy-pass@hk2.shared.example.com:36120?sni=hk2.shared.example.com&insecure=1#%E5%90%88%E7%A7%9FHY2', 1);
const OWN = ownNode();

const ALL = [OWN, SHARE_VLESS, SHARE_HY2];
const visible = () => true;

/* ------------------------------- Base64 订阅 ------------------------------- */

const links = sub.buildLinks(ALL, SERVERS, USER, visible, null);
ok('混合输出条数', links.length === 3, links.map((l) => l.name).join(' / '));

const ownLink = links.find((l) => l.name === '自建节点');
const shareLink = links.find((l) => l.name === '合租HK');
const hy2Link = links.find((l) => l.name === '合租HY2');

ok('自建节点用面板用户 UUID', ownLink && ownLink.uri.includes('@own.example.com:443?')
  && ownLink.uri.startsWith('vless://11111111-panel-user-uuid@'));
ok('分享节点用分享 UUID', shareLink && shareLink.uri.startsWith('vless://share-uuid-9999@hk.shared.example.com:443?'));
ok('分享 Reality 参数保留', shareLink && shareLink.uri.includes('pbk=share-pbk') && shareLink.uri.includes('sid=6ba85179'));
ok('分享 hy2 用分享密码', hy2Link && hy2Link.uri.startsWith('hysteria2://share-hy-pass@hk2.shared.example.com:36120?'));
ok('自建 hy2 密码是 u<id>:<uuid> 形态（此处无自建 hy2，抽测 authHy2 回落）',
  links.every((l) => !l.uri.startsWith('hysteria2://11111111-panel-user-uuid')));

/* -------------------------------- Clash 订阅 ------------------------------- */

const yaml = sub.toClash(ALL, SERVERS, USER, '测试站', visible, null, {});
// lib/yaml.js 对中文字符串值加引号（name: "自建节点"），断言带引号形式
ok('Clash 混合输出含全部节点', ['自建节点', '合租HK', '合租HY2'].every((n) => yaml.includes(`name: "${n}"`)));
ok('Clash 分享 vless uuid 正确', /uuid: share-uuid-9999/.test(yaml));
ok('Clash 自建 vless uuid 回落用户', /uuid: 11111111-panel-user-uuid/.test(yaml));
ok('Clash 分享 hy2 密码正确', /password: share-hy-pass/.test(yaml));
ok('Clash 分享 hy2 insecure', /skip-cert-verify: true/.test(yaml));

/* -------------------------------- sing-box 订阅 ----------------------------- */

const sbJson = JSON.parse(sub.toSingBox(ALL, SERVERS, USER, '测试站', visible, null, {}));
const outs = sbJson.outbounds.filter((o) => !['selector', 'urltest', 'direct'].includes(o.type) && o.server);
ok('sing-box 混合输出含全部节点', outs.length === 3, outs.map((o) => o.tag).join(' / '));
const sbShare = outs.find((o) => o.tag === '合租HK');
const sbOwn = outs.find((o) => o.tag === '自建节点');
const sbHy2 = outs.find((o) => o.tag === '合租HY2');
ok('sing-box 分享 vless uuid', sbShare && sbShare.uuid === 'share-uuid-9999');
ok('sing-box 自建 vless uuid 回落', sbOwn && sbOwn.uuid === '11111111-panel-user-uuid');
ok('sing-box 分享 reality 参数', sbShare && sbShare.tls && sbShare.tls.reality
  && sbShare.tls.reality.public_key === 'share-pbk');
ok('sing-box 分享 hy2 密码 + insecure', sbHy2 && sbHy2.password === 'share-hy-pass'
  && sbHy2.tls && sbHy2.tls.insecure === true);

/* --------------------------- insecure / 证书锁定 ---------------------------- */

{
  // 带指纹锁定时 pcs 优先：buildLink 的既有语义是 pin 存在就不输出 allowInsecure
  const n = extNode(
    'vless://pin-uuid@pin.example.com:443?security=tls&sni=pin.example.com&allowInsecure=1&pinSHA256=' + 'a'.repeat(64) + '#PinNode',
    2,
  );
  const uri = sub.buildLink(n, SERVERS, USER, null);
  ok('pinSHA256 转发为 pcs（锁定优先于 insecure）', uri.includes('pcs=' + 'a'.repeat(64)) && !uri.includes('allowInsecure'));
  const p = sub.clashProxy(n, SERVERS, USER, null);
  ok('Clash insecure 语义（imported 忠实转述链接）', p['skip-cert-verify'] === true);
}

{
  // 只带 allowInsecure=1（无 pin）：订阅 URI 照常输出 allowInsecure=1
  const n = extNode(
    'vless://inc-uuid@inc.example.com:443?security=tls&sni=inc.example.com&allowInsecure=1#InsecureNode',
    5,
  );
  const uri = sub.buildLink(n, SERVERS, USER, null);
  ok('allowInsecure=1 转发到订阅 URI', uri.includes('allowInsecure=1'));
}

{
  // 自建节点不受 imported 语义影响：certMode=self + TLS 的 insecure 照旧、无指纹回退 allowInsecure
  // （Reality 分支不输出证书参数 —— 伪装握手无需校验，与 insecure 无关）
  const selfSigned = ownNode({ certMode: 'self', security: 'tls', sni: 'own.example.com' });
  const uri = sub.buildLink(selfSigned, SERVERS, USER, null);
  ok('自建自签节点仍回退 allowInsecure', uri.includes('allowInsecure=1'));
}

/* --------------------------------- trojan/ss -------------------------------- */

{
  const t = extNode('trojan://share-tro-pass@t.example.com:443?type=tcp#TrojanShare', 3);
  const uri = sub.buildLink(t, SERVERS, USER, null);
  ok('trojan 分享密码', uri.startsWith('trojan://share-tro-pass@t.example.com:443?'));
  const s = extNode('ss://YWVzLTI1Ni1nY206c3MtcGFzcw==@s.example.com:8388#SSShare', 4);
  const suri = sub.buildLink(s, SERVERS, USER, null);
  ok('ss 凭证走节点字段', suri.startsWith('ss://') && s.method === 'aes-256-gcm' && s.password === 'ss-pass');
  const sp = sub.clashProxy(s, SERVERS, USER, null);
  ok('ss Clash 密码', sp.password === 'ss-pass');
}

/* --------------------------------- 顺序与显隐 -------------------------------- */

{
  // hidden 的自建节点不输出，外部节点不受影响
  const links2 = sub.buildLinks([ownNode({ hidden: true }), SHARE_VLESS], SERVERS, USER, visible, null);
  ok('自建隐藏不影响外部节点', links2.length === 1 && links2[0].name === '合租HK');
}

console.log(`\nextsubs merge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);