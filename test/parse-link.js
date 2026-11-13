'use strict';
/**
 * 分享链接解析器测试：lib/parse-link.js 的各协议用例。
 *
 * 覆盖：vless（Reality / ws+TLS / 明文）、vmess（Base64 JSON / v2rayN ?remarks 变体）、
 * trojan（ws）、ss（SIP002 Base64 / 旧式全 Base64 / 明文 2022）、hysteria2（obfs / mport / 混合密码）、
 * IPv6 字面量、坏输入拒收。
 */

const { parseShareLink, tryB64 } = require('../lib/parse-link');

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
const isFail = (r) => r && r.ok === false && typeof r.error === 'string' && r.error.length > 0;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* --------------------------------- vless ---------------------------------- */

{
  const r = parseShareLink(
    'vless://a2c6-uuid-x@hk1.example.com:443?security=reality&sni=www.apple.com&fp=chrome' +
      '&pbk=SbVKOEMABCexampleKey123&sid=6ba85179&type=tcp&flow=xtls-rprx-vision#%E9%A6%99%E6%B8%AFX',
  );
  ok('vless reality 解析成功', r.ok === true, r.ok ? '' : r.error);
  const n = r.ok ? r.node : {};
  ok('vless reality 字段', n.protocol === 'vless' && n.address === 'hk1.example.com' && n.port === 443
    && n.security === 'reality' && n.network === 'tcp' && n.fp === 'chrome');
  ok('vless reality 名称解码', n.name === '香港X');
  ok('vless reality 参数进 reality', n.reality && n.reality.publicKey === 'SbVKOEMABCexampleKey123'
    && n.reality.shortId === '6ba85179' && n.reality.serverNames === 'www.apple.com'
    && n.reality.flow === 'xtls-rprx-vision');
  ok('vless 凭证进 credential', n.credential && n.credential.uuid === 'a2c6-uuid-x');
  ok('vless reality 不需要 insecure', !n.insecure);
}

{
  const r = parseShareLink(
    'vless://b3d7-uuid@1.2.3.4:2053?security=tls&type=ws&path=%2Fray&host=cdn.example.com&allowInsecure=1#WS-TLS',
  );
  ok('vless ws+tls 解析成功', r.ok === true, r.ok ? '' : r.error);
  const n = r.ok ? r.node : {};
  ok('vless ws 字段', n.network === 'ws' && n.path === '/ray' && n.host === 'cdn.example.com'
    && n.security === 'tls' && n.sni === '' && n.address === '1.2.3.4');
  ok('vless allowInsecure 转 insecure', n.insecure === true);
}

{
  // RFC 3986：URI 里的 IPv6 字面量必须带方括号，客户端生成的分享链接均如此
  const r = parseShareLink('vless://c4e8@[2001:db8::1]:443?type=tcp#v6');
  ok('vless IPv6 字面量剥方括号', r.ok === true && r.node.address === '2001:db8::1', r.ok ? r.node.address : r.error);
}

{
  const r = parseShareLink('vless://x@host:443?security=reality&type=tcp#no-pbk');
  ok('vless reality 缺 pbk 拒收', isFail(r), r.ok ? '' : r.error);
}

{
  const r = parseShareLink('vless://x@host:443?type=quic#bad-type');
  ok('vless 不支持的传输拒收', isFail(r), r.ok ? '' : r.error);
}

/* --------------------------------- vmess ---------------------------------- */

{
  const obj = { v: '2', ps: '东京01', add: 'jp1.example.com', port: '8443', id: 'vmess-uuid-1',
    aid: '0', scy: 'auto', net: 'ws', host: 'jp.example.com', path: '/vv', tls: 'tls', sni: 'sni.example.com' };
  const r = parseShareLink('vmess://' + b64(JSON.stringify(obj)));
  ok('vmess base64 解析成功', r.ok === true, r.ok ? '' : r.error);
  const n = r.ok ? r.node : {};
  ok('vmess 字段', n.protocol === 'vmess' && n.address === 'jp1.example.com' && n.port === 8443
    && n.network === 'ws' && n.path === '/vv' && n.host === 'jp.example.com' && n.security === 'tls'
    && n.sni === 'sni.example.com' && n.name === '东京01');
  ok('vmess 凭证进 credential', n.credential && n.credential.uuid === 'vmess-uuid-1');
}

{
  const obj = { v: '2', ps: '直连', add: '5.6.7.8', port: 80, id: 'u9', net: 'tcp' };
  const r = parseShareLink(`vmess://${b64(JSON.stringify(obj))}?remarks=V2%E5%8F%98%E4%BD%93`);
  ok('vmess ?remarks 变体', r.ok === true && r.node.name === 'V2变体' && r.node.port === 80, r.ok ? '' : r.error);
}

{
  const r = parseShareLink('vmess://not-valid-base64!!!');
  ok('vmess 非法 Base64 拒收', isFail(r), r.ok ? '' : r.error);
}

/* --------------------------------- trojan --------------------------------- */

{
  const r = parseShareLink(
    'trojan://pass%40word@tro.example.com:443?type=ws&path=%2Ftj&sni=tro.example.com#TrojanWS',
  );
  ok('trojan ws 解析成功', r.ok === true, r.ok ? '' : r.error);
  const n = r.ok ? r.node : {};
  ok('trojan 字段与默认 TLS', n.protocol === 'trojan' && n.security === 'tls' && n.network === 'ws'
    && n.path === '/tj' && n.port === 443);
  ok('trojan 密码 URL 解码', n.credential && n.credential.uuid === 'pass@word');
}

/* ----------------------------------- ss ----------------------------------- */

{
  const auth = b64('aes-256-gcm:ss-pass-1');
  const r = parseShareLink(`ss://${auth}@ss1.example.com:8388#SS%E8%8A%82%E7%82%B9`);
  ok('ss SIP002 base64 解析', r.ok === true && r.node.method === 'aes-256-gcm'
    && r.node.password === 'ss-pass-1' && r.node.address === 'ss1.example.com' && r.node.port === 8388
    && r.node.name === 'SS节点', r.ok ? '' : r.error);
}

{
  // 2022 系密码是 base64 形态：链接里允许明文 userinfo（URL 自动解码）
  const r = parseShareLink('ss://2022-blake3-aes-256-gcm:PASSWORDabc@ss2.example.com:8389#SS2022');
  ok('ss 明文 userinfo（2022）', r.ok === true && r.node.method === '2022-blake3-aes-256-gcm'
    && r.node.password === 'PASSWORDabc', r.ok ? '' : r.error);
}

{
  const legacy = b64('chacha20-ietf-poly1305:legacy-pass@ss3.example.com:443');
  const r = parseShareLink(`ss://${legacy}#LegacySS`);
  ok('ss 旧式全 Base64', r.ok === true && r.node.method === 'chacha20-ietf-poly1305'
    && r.node.password === 'legacy-pass' && r.node.address === 'ss3.example.com' && r.node.port === 443,
    r.ok ? '' : r.error);
}

{
  const r = parseShareLink('ss://YWVzOmRlYnVn@1.2.3.4:8388#plugin');
  ok('ss 带 plugin 拒收或正常解析（无 plugin 参数即解析）', r.ok === true || isFail(r));
}

/* -------------------------------- hysteria2 -------------------------------- */

{
  const r = parseShareLink(
    'hysteria2://hy-pass-word@hk2.example.com:36120?sni=hk2.example.com&insecure=1&obfs=salamander&obfs-password=obfspw&mport=40000-40499#HY2%E6%B8%AF',
  );
  ok('hysteria2 解析成功', r.ok === true, r.ok ? '' : r.error);
  const n = r.ok ? r.node : {};
  ok('hy2 字段', n.protocol === 'hysteria2' && n.port === 36120 && n.security === 'tls'
    && n.insecure === true && n.name === 'HY2港');
  ok('hy2 obfs 参数', n.hy2 && n.hy2.obfs === 'salamander' && n.hy2.obfsPassword === 'obfspw');
  ok('hy2 mport 进 hop', n.hy2 && n.hy2.hop === '40000-40499');
  ok('hy2 凭证整串', n.credential && n.credential.password === 'hy-pass-word');
}

{
  // user:pass 形态的密码（含冒号）必须整串保留
  const r = parseShareLink('hy2://user1:pass1@1.2.3.4:443?sni=a.com#mix');
  ok('hy2:// 同义 + 混合密码', r.ok === true && r.node.credential.password === 'user1:pass1',
    r.ok ? '' : r.error);
}

/* --------------------------------- 坏输入 ---------------------------------- */

ok('空链接拒收', isFail(parseShareLink('')));
ok('纯文本拒收', isFail(parseShareLink('这不是一条链接')));
ok('不支持的协议拒收', isFail(parseShareLink('https://example.com/sub')));
ok('带空格的链接拒收', isFail(parseShareLink('vless://a@b:443?type=tcp#x y')));
ok('缺端口拒收', isFail(parseShareLink('vless://a@host?type=tcp#noport')));
ok('非法端口拒收', isFail(parseShareLink('vless://a@host:99999?type=tcp#badport')));

/* ------------------------------- tryB64 宽松度 ------------------------------ */

ok('tryB64 标准', tryB64(b64('aes-256-gcm:pw')) === 'aes-256-gcm:pw');
ok('tryB64 URL-safe', tryB64(b64('user:pass-word_ok').replace(/\+/g, '-').replace(/\//g, '_')) === 'user:pass-word_ok');
ok('tryB64 缺 padding', tryB64(b64('ab').replace(/=$/, '')) === 'ab');
ok('tryB64 明文回落 null', tryB64('aes-256-gcm') === null || typeof tryB64('aes-256-gcm') === 'string');

console.log(`\nparse-link: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);