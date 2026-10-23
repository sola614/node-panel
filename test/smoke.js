'use strict';
/**
 * 端到端冒烟测试：node test/smoke.js [http://127.0.0.1:8080]
 *
 * 覆盖：
 *   登录 → 建服务器 → 建节点（TLS / Reality / Hysteria2）→ 建套餐 → 建用户
 *   → 套餐隔离（订阅 + 配置双层）→ 独立节点部署 → 流量超额自动剔除 → 清理
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.PANEL_ADMIN_PASSWORD || 'admin888';
const GB = 1024 ** 3;

let token = '';
let pass = 0;
let fail = 0;
const cleanup = [];

const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const json = (obj) => JSON.stringify(obj);

(async () => {
  console.log(`\n▸ 目标面板：${BASE}\n`);

  /* ---------- 0. 健康检查 ---------- */
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  ok('健康检查可用', health.ok === true, `schema v${health.version}`);
  const pkgVersion = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8')).version;
  ok('健康检查带应用版本号', health.app === pkgVersion, `(${health.app}，package.json 是 ${pkgVersion})`);

  /* ---------- 1. 登录 ---------- */
  const login = await call('/api/login', {
    method: 'POST',
    body: json({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  ok('管理员登录', login.status === 200 && !!login.data.token);
  if (!login.data.token) {
    console.log('\n登录失败，终止测试。请确认账号密码（默认 admin / admin888）\n');
    process.exit(1);
  }
  token = login.data.token;
  ok('登录返回应用版本号', login.data.token && login.data.appVersion === pkgVersion, `(${login.data.appVersion})`);

  /* ---------- 0.5 清理上次崩溃的残留，保证测试可重复 ---------- */
  {
    const stale = async (path, key) => {
      const r = await call(path);
      const items = r.data.items || [];
      for (const it of items) {
        if (String(it.name || '').startsWith('SMOKE-')) {
          await call(`${path}/${it.id}`, { method: 'DELETE' });
        }
      }
      return items.length;
    };
    await stale('/api/users');
    await stale('/api/nodes');
    await stale('/api/servers');
    await stale('/api/plans');
    console.log('  · 已清理上次运行的残留数据');
  }

  /* ---------- 1. 存量数据自检（防止种子数据缺 id 之类的结构问题） ---------- */
  const allNodes = await call('/api/nodes');
  const allPlans = await call('/api/plans');
  const nodeIdSet = new Set(allNodes.data.items.map((n) => n.id));
  ok('所有节点都有 id', allNodes.data.items.every((n) => !!n.id), `共 ${allNodes.data.items.length} 个`);
  ok('节点 id 唯一', nodeIdSet.size === allNodes.data.items.length);
  ok('套餐引用的节点都存在',
    allPlans.data.items.every((p) => (p.nodeIds || []).every((id) => nodeIdSet.has(id))));

  /* ---------- 2. 服务器 + 节点 ---------- */
  const server = await call('/api/servers', {
    method: 'POST',
    body: json({ name: 'SMOKE-服务器', host: 'smoke.example.com', note: '自动化测试' }),
  });
  ok('新增服务器', server.status === 200);
  const serverId = server.data.item.id;
  const serverToken = server.data.item.token;
  cleanup.push(['/api/servers/' + serverId]);

  // 2.1 跟随服务器的普通节点
  const node1 = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-TLS', mode: 'server', serverId, protocol: 'vless', port: 20443,
      network: 'ws', path: '/smoke', security: 'tls', sni: 'smoke.example.com',
      certFile: '/etc/ssl/smoke/fullchain.pem', keyFile: '/etc/ssl/smoke/privkey.pem', enabled: true,
    }),
  });
  ok('新增节点（跟随服务器）', node1.status === 200);
  const node1Id = node1.data.item.id;
  cleanup.push(['/api/nodes/' + node1Id]);

  // 2.2 Reality 密钥
  const keyPair = await call('/api/reality/keys', { method: 'POST' });
  ok('生成 Reality 密钥对', keyPair.status === 200 && keyPair.data.privateKey.length > 40,
    `pub=${(keyPair.data.publicKey || '').slice(0, 10)}…`);

  // 2.3 独立部署 + Reality
  const node2 = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-REALITY', mode: 'standalone', address: 'sg.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'reality',
      reality: {
        dest: 'www.microsoft.com:443', serverNames: 'www.microsoft.com',
        privateKey: keyPair.data.privateKey, publicKey: keyPair.data.publicKey,
        shortId: keyPair.data.shortId, flow: 'xtls-rprx-vision',
      },
      enabled: true,
    }),
  });
  ok('新增节点（独立部署 + Reality）', node2.status === 200);
  const node2Id = node2.data.item.id;
  const node2Token = node2.data.item.token;
  cleanup.push(['/api/nodes/' + node2Id]);

  // 2.4 独立部署 + Hysteria2
  const node3 = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-HY2', mode: 'standalone', address: 'hy.example.com',
      protocol: 'hysteria2', port: 20843, security: 'tls', sni: 'hy.example.com',
      certFile: '/etc/ssl/hy/fullchain.pem', keyFile: '/etc/ssl/hy/privkey.pem',
      hy2: { obfs: 'salamander', obfsPassword: 'obfspass', upMbps: 50, downMbps: 500, maskUrl: 'https://example.com/' },
      enabled: true,
    }),
  });
  ok('新增节点（独立部署 + Hysteria2）', node3.status === 200);
  const node3Id = node3.data.item.id;
  const node3Token = node3.data.item.token;
  cleanup.push(['/api/nodes/' + node3Id]);

  /* ---------- 3. 套餐（只定义额度与有效期） ---------- */
  const plan = await call('/api/plans', {
    method: 'POST',
    body: json({ name: 'SMOKE-套餐', desc: '只含 SMOKE-TLS', quotaGB: 0.5, days: 7, color: '#4c8dff', sort: 99 }),
  });
  ok('新增套餐（含额度与有效期）',
    plan.status === 200 && plan.data.item.nodeCount === 0 && plan.data.item.quotaGB === 0.5 && plan.data.item.days === 7);
  const planId = plan.data.item.id;
  cleanup.push(['/api/plans/' + planId]);

  const emptyPlan = await call('/api/plans', {
    method: 'POST',
    body: json({ name: 'SMOKE-空套餐', desc: '不含任何节点', quotaGB: 0, days: 0, sort: 100 }),
  });
  const emptyPlanId = emptyPlan.data.item.id;
  cleanup.push(['/api/plans/' + emptyPlanId]);

  /* ---------- 4. 用户（额度与到期继承套餐） ---------- */
  const mkUser = async (name, planId_, quotaGB) => {
    const r = await call('/api/users', {
      method: 'POST',
      body: json({ name, planId: planId_, quotaGB, expireAt: new Date(Date.now() + 7 * 864e5).toISOString() }),
    });
    cleanup.push(['/api/users/' + r.data.item.id]);
    return r.data.item;
  };

  const u1 = await mkUser('SMOKE-套餐用户', planId, 0.5);
  const u2 = await mkUser('SMOKE-不限套餐', null, 100);
  const u3 = await mkUser('SMOKE-空套餐用户', emptyPlanId, 100);
  ok('新增用户（绑定套餐 / 不限 / 空套餐）', !!(u1.id && u2.id && u3.id));

  ok('用户额度继承套餐', u1.quotaGB === 0.5, `(${u1.quotaGB}GB)`);
  ok('用户到期按套餐天数推算',
    u1.expireAt && Math.abs(new Date(u1.expireAt) - (new Date(u1.createdAt).getTime() + 7 * 864e5)) < 60000);
  ok('无套餐用户可手填额度', u2.quotaGB === 100);
  ok('额度继承标记为锁定', u1.quotaLocked === true && u2.quotaLocked === false);

  // 改套餐额度，用户侧要跟着变
  const planUpdate = await call('/api/plans/' + planId, { method: 'PUT', body: json({ quotaGB: 2, days: 14 }) });
  ok('修改套餐额度', planUpdate.status === 200 && planUpdate.data.item.quotaGB === 2);
  const u1After = (await call('/api/users')).data.items.find((u) => u.id === u1.id);
  ok('套餐变更同步到用户', u1After.quotaGB === 2, `(${u1After.quotaGB}GB)`);

  // 节点加入套餐
  await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ planIds: [planId] }) });

  /* ---------- 5. 订阅层套餐隔离 ---------- */
  const sub1 = await call(`/api/sub/${u1.token}`);
  const names1 = (sub1.data.links || []).map((l) => l.name);
  ok('套餐用户只看到套餐内节点', names1.length === 1 && names1[0].includes('SMOKE-TLS'), `(${names1.join(',')})`);

  const sub2 = await call(`/api/sub/${u2.token}`);
  const names2 = (sub2.data.links || []).map((l) => l.name);
  ok('不限套餐用户看到全部节点', names2.some((n) => n.includes('SMOKE-REALITY')) && names2.some((n) => n.includes('SMOKE-HY2')));

  const sub3 = await call(`/api/sub/${u3.token}`);
  ok('空套餐用户看不到任何节点', (sub3.data.links || []).length === 0);

  /* ---------- 6. 链接格式 ---------- */
  const realityLink = (sub2.data.links || []).find((l) => l.name.includes('SMOKE-REALITY'));
  ok('Reality 链接带 pbk/sid/flow',
    !!realityLink && realityLink.uri.includes('security=reality') &&
    realityLink.uri.includes('pbk=') && realityLink.uri.includes('sid=') &&
    realityLink.uri.includes('flow=xtls-rprx-vision'));

  const hy2Link = (sub2.data.links || []).find((l) => l.name.includes('SMOKE-HY2'));
  ok('Hysteria2 链接格式正确',
    !!hy2Link && hy2Link.uri.startsWith('hysteria2://') &&
    hy2Link.uri.includes('obfs=salamander') && hy2Link.uri.includes('obfs-password=obfspass'));

  const clash = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅含 reality-opts 与 hysteria2',
    clash.includes('reality-opts') && clash.includes('public-key') &&
    clash.includes('type: hysteria2') && clash.includes('obfs-password'));

  /* ---------- 7. 配置层套餐隔离（服务器 agent） ---------- */
  const cfgServer = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inbound = cfgServer.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  const emails = inbound ? inbound.settings.clients.map((c) => c.email) : [];
  ok('服务器 agent 拉到自己名下的节点', !!inbound);
  ok('套餐内用户被注入', emails.includes('u' + u1.id));
  ok('不限套餐用户被注入', emails.includes('u' + u2.id));
  ok('空套餐用户未被注入', !emails.includes('u' + u3.id));
  ok('Reality 入站使用 reality 加密',
    cfgServer.data.xray.inbounds.some((i) => i.streamSettings && i.streamSettings.security === 'reality') === false,
    '（该服务器没有 Reality 节点，符合预期）');

  /* ---------- 8. 独立节点 agent ---------- */
  const cfgNode2 = await call(`/api/agent/config?token=${node2Token}&v=test`);
  ok('独立节点用自己的 token 拉到配置', cfgNode2.status === 200 && cfgNode2.data.scope.type === 'node');
  ok('独立节点只含自己', cfgNode2.data.nodes.length === 1 && cfgNode2.data.nodes[0].id === node2Id);

  const realityInbound = cfgNode2.data.xray.inbounds.find((i) => i.tag === 'node-' + node2Id);
  ok('Reality 入站包含 realitySettings',
    !!realityInbound && realityInbound.streamSettings.security === 'reality' &&
    realityInbound.streamSettings.realitySettings.privateKey === keyPair.data.privateKey);
  ok('Reality 客户端启用 vision 流控',
    realityInbound.settings.clients.every((c) => c.flow === 'xtls-rprx-vision'));

  /* ---------- 9. Hysteria2 配置 ---------- */
  const cfgNode3 = await call(`/api/agent/config?token=${node3Token}&v=test`);
  const hy = (cfgNode3.data.hysteria || [])[0];
  ok('Hysteria2 节点下发独立配置',
    !!hy && (hy.yaml.includes('listen: :20843') || hy.yaml.includes('listen: ":20843"')), hy ? `端口 ${hy.port}` : '');
  ok('Hysteria2 含 userpass 认证', !!hy && hy.yaml.includes('userpass') && hy.yaml.includes('u' + u2.id));
  ok('Hysteria2 含带宽与混淆', !!hy && hy.yaml.includes('salamander') && hy.yaml.includes('mbps'));
  ok('Hysteria2 带流量统计端口', !!hy && hy.statsPort >= 9000 && hy.statsPort < 9900 && !!hy.secret,
    `port=${hy && hy.statsPort}`);

  // 同一台机器上多个 Hysteria2 实例的统计端口不得碰撞（否则流量串号）
  const hy2All = cfgNode3.data.hysteria || [];
  ok('同机多实例统计端口不碰撞', new Set(hy2All.map((x) => x.statsPort)).size === hy2All.length,
    `(${hy2All.map((x) => x.statsPort).join(',')})`);
  ok('统计端口在 YAML 中一致',
    hy2All.every((x) => x.yaml.includes(`127.0.0.1:${x.statsPort}`)));

  /* ---------- 10. 超额自动剔除 ---------- */
  const report = await call(`/api/agent/report?token=${serverToken}`, {
    method: 'POST',
    // 套餐额度已被上文改成 2GB，上报 3GB 必然超限
    body: json({ users: [{ email: 'u' + u1.id, up: 1.5 * GB, down: 1.5 * GB }] }),
  });
  ok('流量上报成功', report.status === 200 && report.data.applied === 1);

  const usersAfter = await call('/api/users');
  const me1 = usersAfter.data.items.find((u) => u.id === u1.id);
  ok('用户状态变为「超量」', me1 && me1.status === 'over', `(${me1?.statusLabel})`);

  const cfgAfter = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inboundAfter = cfgAfter.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  const stillIn = inboundAfter && inboundAfter.settings.clients.some((c) => c.email === 'u' + u1.id);
  ok('超量用户被移出节点配置', !stillIn);

  const subAfter = await call(`/api/sub/${u1.token}`);
  ok('超量用户订阅为空', (subAfter.data.links || []).length === 0);

  /* ---------- 11. 部署脚本 ---------- */
  const srvInstall = await fetch(`${BASE}/api/servers/${serverId}/install?token=${serverToken}`).then((r) => r.text());
  ok('服务器部署脚本可下载', srvInstall.startsWith('#!/bin/sh') && srvInstall.includes(serverToken));
  ok('部署脚本不再要求 Node 运行时', !srvInstall.includes('command -v node') && !srvInstall.includes('node /opt/nodepanel'));
  ok('脚本内嵌 shell agent', srvInstall.includes('Node Panel Agent') && srvInstall.includes('NODEPANEL_AGENT_EOF'));
  ok('脚本注册服务（systemd + OpenRC 双分支）',
    srvInstall.includes('nodepanel-agent.service') && srvInstall.includes('/run/systemd/system') && srvInstall.includes('rc-update add nodepanel-agent'));

  const nodeInstall = await fetch(`${BASE}/api/nodes/${node3Id}/install?token=${node3Token}`).then((r) => r.text());
  ok('独立节点部署脚本可下载', nodeInstall.startsWith('#!/bin/sh') && nodeInstall.includes(node3Token));
  ok('Hysteria2 节点脚本会安装 hysteria', nodeInstall.includes('NEED_HYSTERIA="1"'));

  const badInstall = await fetch(`${BASE}/api/nodes/${node3Id}/install?token=wrong`).then((r) => r.status);
  ok('错误的节点 token 无法获取脚本', badInstall === 401);

  /* ---------- 11.2 agent 配置包（shell 协议） ---------- */
  const bundleRes = await fetch(`${BASE}/api/agent/bundle?token=${serverToken}`);
  const bundle = await bundleRes.text();
  ok('配置包可下发', bundleRes.status === 200 && bundle.startsWith('#!/bin/sh'));
  ok('配置包以 base64 内嵌文件', bundle.includes('base64 -d') && bundle.includes("np_put '"));
  ok('配置包写入 state.env 供 agent 读取', bundle.includes('NP_HY2_LIST=') && bundle.includes('NP_STATS='));

  const bundleHash = /NP_HASH='([^']+)'/.exec(bundle);
  ok('配置包带 hash', !!bundleHash);
  const unchanged = await fetch(`${BASE}/api/agent/bundle?token=${serverToken}&hash=${bundleHash[1]}`).then((r) => r.text());
  ok('hash 未变时只回一行', unchanged.trim() === '#UNCHANGED');

  const badBundle = await fetch(`${BASE}/api/agent/bundle?token=wrong`).then((r) => r.text());
  ok('错误 token 拿不到配置包', badBundle.startsWith('#ERROR'));

  // 纯文本上报（shell agent 用的格式）
  const textReport = await fetch(`${BASE}/api/agent/report?token=${serverToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: `u${u2.id} 11 22\n# 注释行\n\nu${u3.id} 1 1\n`,
  }).then((r) => r.json());
  ok('纯文本上报可用（跳过注释与空行）', textReport.applied === 2 && textReport.bytes === 35, JSON.stringify(textReport));

  const serverNodeInstall = await fetch(`${BASE}/api/nodes/${node1Id}/install?token=${serverToken}`).then((r) => r.status);
  ok('跟随服务器的节点拒绝独立部署脚本', serverNodeInstall === 400);

  /* ---------- 11.5 公网地址上报 ---------- */
  const REPORTED_IP = '198.51.100.77';

  // 服务器默认为手动模式，上报不应覆盖手填地址
  const cfgWithIp = await call(`/api/agent/config?token=${serverToken}&v=test&ip=${REPORTED_IP}`);
  ok('agent 拉配置时附带 IP 不影响手动模式', cfgWithIp.status === 200);
  const srvAfter = (await call('/api/servers')).data.items.find((s) => s.id === serverId);
  ok('手动模式下上报 IP 被忽略', srvAfter.reportedIp === '' && srvAfter.host === 'smoke.example.com',
    `address=${srvAfter.address}(${srvAfter.addressSource})`);

  // 切到自动模式
  const switched = await call('/api/servers/' + serverId, {
    method: 'PUT',
    body: json({ ipMode: 'auto' }),
  });
  ok('服务器可切换为自动上报模式', switched.status === 200 && switched.data.item.ipMode === 'auto');

  await call(`/api/agent/config?token=${serverToken}&v=test&ip=${REPORTED_IP}`);
  const srvAuto = (await call('/api/servers')).data.items.find((s) => s.id === serverId);
  ok('自动模式记录上报的 IP', srvAuto.reportedIp === REPORTED_IP, `reportedIp=${srvAuto.reportedIp}`);
  ok('自动模式生效地址取上报 IP', srvAuto.address === REPORTED_IP && srvAuto.addressSource === '上报');

  // 订阅链接应使用上报的 IP
  const subIp = await call(`/api/sub/${u2.token}`);
  const ipLink = (subIp.data.links || []).find((l) => l.name.includes('SMOKE-TLS'));
  ok('订阅链接使用上报的 IP', !!ipLink && ipLink.host === REPORTED_IP, `host=${ipLink && ipLink.host}`);

  // 独立节点同样支持上报
  const node3Auto = await call('/api/nodes/' + node3Id, { method: 'PUT', body: json({ ipMode: 'auto', address: '' }) });
  ok('独立节点可切换为自动上报模式',
    node3Auto.status === 200 && node3Auto.data.item.ipMode === 'auto' && node3Auto.data.item.mode === 'standalone',
    '（部分更新不应改变部署方式）');
  await call(`/api/agent/config?token=${node3Token}&v=test&ip=${REPORTED_IP}`);
  const node3After = (await call('/api/nodes')).data.items.find((n) => n.id === node3Id);
  ok('独立节点记录上报的 IP', node3After.reportedIp === REPORTED_IP);
  const subHy2 = await call(`/api/sub/${u2.token}`);
  const hy2ip = (subHy2.data.links || []).find((l) => l.name.includes('SMOKE-HY2'));
  ok('Hysteria2 链接使用上报的 IP', !!hy2ip && hy2ip.host === REPORTED_IP, `host=${hy2ip && hy2ip.host}`);

  /* ---------- 11.6 证书 / uTLS / VLESS Encryption / 中转入口 ---------- */

  // 粘贴证书内容
  const nodeCert = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-CERT', mode: 'standalone', address: 'cert.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'tls', sni: 'cert.example.com',
      certMode: 'content',
      certPem: '-----BEGIN CERTIFICATE-----\nSMOKE-CERT\n-----END CERTIFICATE-----\n',
      keyPem: '-----BEGIN PRIVATE KEY-----\nSMOKE-KEY\n-----END PRIVATE KEY-----\n',
      fp: 'firefox', enabled: true,
    }),
  });
  ok('新增节点（粘贴证书内容）', nodeCert.status === 200 && nodeCert.data.item.certMode === 'content');
  const nodeCertId = nodeCert.data.item.id;
  cleanup.push(['/api/nodes/' + nodeCertId]);

  // 自签证书
  const nodeSelf = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-SELF', mode: 'standalone', address: 'self.example.com',
      protocol: 'trojan', port: 443, network: 'tcp', security: 'tls',
      certMode: 'self', selfCN: 'self.example.com', sni: 'self.example.com', enabled: true,
    }),
  });
  ok('新增节点（自签证书）', nodeSelf.status === 200 && nodeSelf.data.item.certMode === 'self');
  const nodeSelfId = nodeSelf.data.item.id;
  cleanup.push(['/api/nodes/' + nodeSelfId]);

  const subCert = await call(`/api/sub/${u2.token}`);
  const certLink = (subCert.data.links || []).find((l) => l.name.includes('SMOKE-CERT'));
  ok('粘贴证书的节点使用固定落地路径',
    !!certLink && (await call(`/api/nodes/${nodeCertId}/preview`)).data.kind === 'xray');
  const cfgCert = await call(`/api/agent/config?token=${nodeCert.data.item.token}&v=test`);
  const certInbound = cfgCert.data.xray.inbounds.find((i) => i.tag === 'node-' + nodeCertId);
  ok('content 模式证书指向 agent 落地路径',
    !!certInbound && certInbound.streamSettings.tlsSettings.certificates[0].certificateFile.includes('/etc/nodepanel/certs/' + nodeCertId),
    certInbound ? certInbound.streamSettings.tlsSettings.certificates[0].certificateFile : '');
  ok('uTLS 指纹写入链接', !!certLink && certLink.uri.includes('fp=firefox'));
  ok('证书 PEM 下发给 agent',
    (cfgCert.data.certs || []).some((c) => c.nodeId === nodeCertId && c.certPem.includes('SMOKE-CERT') && c.keyPem.includes('SMOKE-KEY')));

  const selfLink = (subCert.data.links || []).find((l) => l.name.includes('SMOKE-SELF'));
  ok('自签证书链接带 allowInsecure', !!selfLink && selfLink.uri.includes('allowInsecure=1'));

  // VLESS Encryption
  const nodeVe = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-VE', mode: 'standalone', address: 've.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'tls', sni: 've.example.com',
      certMode: 'self', vlessEncryption: true, enabled: true,
    }),
  });
  ok('新增节点（VLESS Encryption）', nodeVe.status === 200 && nodeVe.data.item.vlessEncryption === true);
  const nodeVeId = nodeVe.data.item.id;
  const nodeVeToken = nodeVe.data.item.token;
  cleanup.push(['/api/nodes/' + nodeVeId]);

  const cfgVe = await call(`/api/agent/config?token=${nodeVeToken}&v=test`);
  const veInbound = cfgVe.data.xray.inbounds.find((i) => i.tag === 'node-' + nodeVeId);
  ok('VLESS Encryption 写入服务端配置',
    !!veInbound && veInbound.settings.encryption === 'mlkem768x25519plus' && veInbound.settings.decryption === undefined);

  const subVe = await call(`/api/sub/${u2.token}`);
  const veLink = (subVe.data.links || []).find((l) => l.name.includes('SMOKE-VE'));
  ok('VLESS Encryption 写入订阅链接', !!veLink && veLink.uri.includes('encryption=mlkem768x25519plus'));

  const clashVe = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅包含 encryption 与 client-fingerprint',
    clashVe.includes('encryption: mlkem768x25519plus') && clashVe.includes('client-fingerprint'));

  // 中转入口
  const relayNode = await call('/api/nodes/' + node1Id, {
    method: 'PUT',
    body: json({
      entries: [
        { name: '入口A', host: 'relay-a.example.com' },
        { name: '入口B', host: 'relay-b.example.com', port: 20443, planIds: [emptyPlanId] },
        { name: '隐藏入口', host: 'relay-c.example.com', hidden: true },
      ],
    }),
  });
  ok('节点可配置中转入口', relayNode.status === 200 && relayNode.data.item.entries.length === 3);

  const subRelay = await call(`/api/sub/${u2.token}`);
  const relayLinks = (subRelay.data.links || []).filter((l) => l.name.includes('SMOKE-TLS'));
  // u2 不限套餐：能看到直连 + 继承节点套餐的入口A；入口B 自有套餐（空套餐）故不可见
  ok('直连与继承套餐的入口照常发布', relayLinks.length === 2, `(${relayLinks.map((l) => l.host).join(', ')})`);
  ok('入口链接使用入口地址与端口',
    relayLinks.some((l) => l.host === 'relay-a.example.com' && l.port === 20443));
  // 服务器此前被切到自动上报模式，直连地址应为上报的 IP 而非手填 host
  ok('直连使用节点自身（上报）地址', relayLinks.some((l) => !l.relay && l.host === REPORTED_IP),
    `(${relayLinks.filter((l) => !l.relay).map((l) => l.host).join(',') || '无直连'})`);
  ok('隐藏的入口不出现在订阅', !relayLinks.some((l) => l.host === 'relay-c.example.com'));

  // 入口自有套餐：入口B 只归空套餐，空套餐用户应看到它，套餐用户不应看到
  const subU3 = await call(`/api/sub/${u3.token}`);
  const u3Links = (subU3.data.links || []).filter((l) => l.name.includes('SMOKE-TLS'));
  ok('入口自有套餐优先于节点套餐', u3Links.length === 1 && u3Links[0].host === 'relay-b.example.com',
    `(${u3Links.map((l) => l.host).join(', ')})`);

  // 入口拿到访问权后，节点配置也必须服务该用户，否则中转过去连不上
  const cfgRelay = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inboundRelay = cfgRelay.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  ok('入口套餐用户被注入节点配置',
    inboundRelay.settings.clients.some((c) => c.email === 'u' + u3.id));

  // 原始节点隐藏：直连消失，中转入口仍在
  await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ hidden: true }) });
  const subHidden = await call(`/api/sub/${u2.token}`);
  const hiddenLinks = (subHidden.data.links || []).filter((l) => l.name.includes('SMOKE-TLS'));
  ok('节点隐藏后直连从订阅消失', !hiddenLinks.some((l) => !l.relay));
  ok('节点隐藏后中转入口仍可用', hiddenLinks.length === 1 && hiddenLinks.every((l) => l.relay),
    `(${hiddenLinks.map((l) => l.host).join(', ')})`);
  const clashHidden = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  // 注意：smoke.example.com 同时还是该节点的 SNI，中转代理会继承它，
  // 所以不能用它判断直连是否消失，要认直连代理的完整名字
  const directProxyName = '"SMOKE-服务器 · SMOKE-TLS"';
  ok('Clash 订阅同样只保留中转入口',
    clashHidden.includes('relay-a.example.com') && !clashHidden.includes(directProxyName));

  // 隐藏不影响 agent 配置（中转链路因此不受影响）
  const cfgHidden = await call(`/api/agent/config?token=${serverToken}&v=test`);
  const inboundHidden = cfgHidden.data.xray.inbounds.find((i) => i.tag === 'node-' + node1Id);
  ok('节点隐藏不影响 agent 配置', !!inboundHidden && inboundHidden.settings.clients.length > 0);

  await call('/api/nodes/' + node1Id, { method: 'PUT', body: json({ hidden: false }) });

  const clashRelay = await fetch(`${BASE}/s/${u2.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅包含中转入口节点', clashRelay.includes('relay-a.example.com'));
  const clashU3 = await fetch(`${BASE}/s/${u3.token}?format=clash`).then((r) => r.text());
  ok('Clash 订阅遵循入口自有套餐',
    clashU3.includes('relay-b.example.com') && !clashU3.includes('relay-a.example.com'));

  const relayScript = await fetch(`${BASE}/api/relay/script?to=203.0.113.9&port=443&label=SMOKE`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const relayText = await relayScript.text();
  ok('中转脚本可生成', relayScript.status === 200 && relayText.includes('DNAT'));
  ok('中转脚本按协议生成规则', relayText.includes('PREROUTING -p tcp') && relayText.includes('PREROUTING -p udp'));

  const relayBad = await fetch(`${BASE}/api/relay/script`, { headers: { Authorization: 'Bearer ' + token } });
  ok('缺少落地地址时中转脚本报错', relayBad.status === 400);

  // ACME 证书模式
  const nodeAcme = await call('/api/nodes', {
    method: 'POST',
    body: json({
      name: 'SMOKE-ACME', mode: 'standalone', address: 'acme.example.com',
      protocol: 'vless', port: 443, network: 'tcp', security: 'tls',
      sni: 'acme.example.com', certMode: 'acme', selfCN: 'acme.example.com', enabled: true,
    }),
  });
  ok('新增节点（ACME 证书）', nodeAcme.status === 200 && nodeAcme.data.item.certMode === 'acme');
  const nodeAcmeId = nodeAcme.data.item.id;
  cleanup.push(['/api/nodes/' + nodeAcmeId]);

  const cfgAcme = await call(`/api/agent/config?token=${nodeAcme.data.item.token}&v=test`);
  const acmeCert = (cfgAcme.data.certs || []).find((c) => c.nodeId === nodeAcmeId);
  ok('ACME 模式下发给 agent 申请指令', !!acmeCert && acmeCert.mode === 'acme' && acmeCert.cn === 'acme.example.com');

  const subAcme = await call(`/api/sub/${u2.token}`);
  const acmeLink = (subAcme.data.links || []).find((l) => l.name.includes('SMOKE-ACME'));
  ok('ACME 证书不需要 allowInsecure', !!acmeLink && !acmeLink.uri.includes('allowInsecure'));

  /* ---------- 11.9 设置 · 订阅对外域名校验 ---------- */
  const baseBefore = (await call('/api/settings')).data.settings.subBase;

  const nakedNumber = await call('/api/settings', { method: 'PUT', body: json({ subBase: '111' }) });
  ok('裸数字（111）被拒绝', nakedNumber.status === 400, `(${nakedNumber.data.error || ''})`);
  ok('非法值不会落盘', (await call('/api/settings')).data.settings.subBase === baseBefore);

  const badBases = [
    ['缺主机名', 'http://'],
    ['非 http(s) 协议', 'ftp://sub.example.com'],
    ['带路径', 'https://sub.example.com/sub'],
    ['带查询参数', 'https://sub.example.com?a=1'],
    ['带空格', 'sub example.com'],
    ['端口越界', 'https://sub.example.com:99999'],
  ];
  for (const [label, bad] of badBases) {
    const r = await call('/api/settings', { method: 'PUT', body: json({ subBase: bad }) });
    ok(`拒绝非法地址：${label}`, r.status === 400, `(${bad} → ${r.data.error || ''})`);
  }

  const bare = await call('/api/settings', { method: 'PUT', body: json({ subBase: 'sub.example.com' }) });
  ok('裸域名自动补全 https://',
    bare.status === 200 && bare.data.settings.subBase === 'https://sub.example.com',
    `(${bare.data.settings.subBase})`);

  const withPort = await call('/api/settings', { method: 'PUT', body: json({ subBase: 'http://sub.example.com:8080/' }) });
  ok('保留端口并去掉尾部斜杠',
    withPort.status === 200 && withPort.data.settings.subBase === 'http://sub.example.com:8080',
    `(${withPort.data.settings.subBase})`);

  const ipBase = await call('/api/settings', { method: 'PUT', body: json({ subBase: 'https://203.0.113.7' }) });
  ok('允许 IP 形式的域名', ipBase.status === 200 && ipBase.data.settings.subBase === 'https://203.0.113.7');

  const subWithBase = await call(`/api/sub/${u2.token}`);
  ok('订阅链接使用自定义域名',
    String(subWithBase.data.subUrl || '').startsWith('https://203.0.113.7/s/'),
    `(${subWithBase.data.subUrl || ''})`);

  const cleared = await call('/api/settings', { method: 'PUT', body: json({ subBase: '' }) });
  ok('留空表示自动跟随访问地址', cleared.status === 200 && cleared.data.settings.subBase === '');

  // 还原测试前的设置
  await call('/api/settings', { method: 'PUT', body: json({ subBase: baseBefore }) });

  /* ---------- 12. 鉴权 ---------- */  ok('错误 token 无法拉配置', (await call('/api/agent/config?token=wrong-token')).status === 401);

  const saved = token;
  token = '';
  ok('未登录访问管理接口被拒绝', (await call('/api/users')).status === 401);
  token = saved;

  /* ---------- 13. 清理 ---------- */
  for (const [path] of cleanup.reverse()) {
    await call(path, { method: 'DELETE' });
  }
  const left = await call('/api/servers');
  ok('测试数据已清理', !left.data.items.some((s) => s.id === serverId));

  console.log(`\n▸ 结果：${pass} 项通过，${fail} 项失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常：', err.message, '\n');
  process.exit(1);
});
