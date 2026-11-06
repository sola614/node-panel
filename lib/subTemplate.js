'use strict';

/**
 * subconverter 自定义配置（`[custom]` 段的 ruleset / custom_proxy_group）
 * → 面板的 Clash 订阅模板 JSON。
 *
 * 为什么要有这一步：面板直出的订阅才带 REALITY 的 `support-x25519mlkem768`，
 * 而 subconverter 不认识这个参数，转换时整条丢掉，于是 VLESS 节点在 Clash 里
 * 全部 timeout（HY2 不受影响，所以看起来像「只有 vless 坏了」）。用户手里
 * 已有的 sub.toml 其实只描述「分组 + 规则」，把它翻译成面板模板，就能绕开
 * 转换器、直接吃面板订阅。
 *
 * 转换约定：
 *   `ruleset=组名,clash-classic:URL`  → rule-providers 里加一条 RULE-SET
 *   `ruleset=DIRECT,[]GEOIP,CN`       → 内联规则 GEOIP,CN,DIRECT
 *   `custom_proxy_group=组`select`[]A`[]B`.*`
 *       → select 组，proxies 依次是 A、B、{all}
 *
 * 正则只做安全转换：`.*` → `{all}`，`香港|日本` → `{filter:香港|日本}`；
 * 带 `\d`、`[]`、`()` 这类元字符的一律退化成 `{all}` 并记 warning ——
 * 面板模板的占位符只支持关键词包含，硬转只会生成一个永远匹配不到节点的空分组。
 */

const MAX_BYTES = 1024 * 1024;
const MAX_RULES = 3000;
const GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance', 'relay']);
const PROVIDER_INTERVAL = 86400;

/** `clash-classic:` 这类前缀 → Clash 的 behavior */
function behaviorOf(scheme) {
  switch (String(scheme || '').toLowerCase()) {
    case 'clash-classic':
    case 'clash':
      return 'classical';
    case 'clash-domain':
    case 'clash-domains':
      return 'domain';
    case 'clash-ipcidr':
      return 'ipcidr';
    default:
      return '';
  }
}

/** 取出 [custom] 段里的 ruleset / custom_proxy_group，保持文件里的先后顺序 */
function parseCustom(text) {
  const out = [];
  let section = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (section === 'custom' && (key === 'ruleset' || key === 'custom_proxy_group')) {
      out.push({ key, value });
    }
  }
  return out;
}

/** subconverter 的节点正则 → 面板占位符；转不了返回 null */
function regexToRef(re) {
  let s = String(re == null ? '' : re).trim();
  if (!s) return null;
  s = s.replace(/^\(\?i\)/, '').trim();
  if (/^(\.\*|\.\+|\*|\^\.\*\$$)$/.test(s)) return '{all}';
  if (/[\\[\](){}^$+*?]/.test(s)) return null;
  const kws = s.split('|').map((x) => x.trim()).filter(Boolean);
  if (!kws.length) return null;
  return `{filter:${kws.join('|')}}`;
}

function proxyRef(item, groupName, warnings) {
  const s = String(item == null ? '' : item).trim();
  if (!s) return null;
  if (s.startsWith('[]')) return s.slice(2).trim() || null;
  const ref = regexToRef(s);
  if (ref) return ref;
  warnings.push(`分组「${groupName}」的节点正则 ${s} 无法转成关键词，已按全部节点处理`);
  return '{all}';
}

/** `名字`select`[]A`.*`URL`300,,50 → { name, type, proxies, url, interval } */
function parseGroup(value, warnings) {
  const parts = String(value).split('`');
  const name = String(parts.shift() || '').trim();
  if (!name) return null;
  const rawType = String(parts.shift() || 'select').trim().toLowerCase();
  const type = GROUP_TYPES.has(rawType) ? rawType : 'select';
  if (type !== rawType) warnings.push(`分组「${name}」的类型 ${rawType} 不支持，按 select 处理`);

  // url-test / fallback 的 URL 写在节点正则之后，所以先定位它
  const urlIdx = parts.findIndex((p) => /^https?:\/\//i.test(p.trim()));
  const head = urlIdx >= 0 ? parts.slice(0, urlIdx) : parts;

  const proxies = [];
  for (const p of head) {
    const ref = proxyRef(p, name, warnings);
    if (ref && !proxies.includes(ref)) proxies.push(ref);
  }
  if (!proxies.length) proxies.push('{all}');

  const g = { name, type, proxies };
  if (urlIdx >= 0 && type !== 'select' && type !== 'relay') {
    g.url = parts[urlIdx].trim();
    // 第 5 段是 `300,,50`（interval,,tolerance），只取 interval
    const m = /^(\d+)/.exec(String(parts[urlIdx + 1] || '').trim());
    if (m) g.interval = Number(m[1]);
  }
  return g;
}

/**
 * 解析模板文本。返回 { ok, template, stats, warnings }，
 * template 是可直接存进 settings.clashTemplate 的对象。
 */
function convert(text) {
  const src = String(text == null ? '' : text);
  if (src.length > MAX_BYTES) {
    return { ok: false, error: `模板文件太大（上限 ${MAX_BYTES / 1024} KB）` };
  }

  const items = parseCustom(src);
  if (!items.length) {
    return { ok: false, error: '没找到 [custom] 段里的 ruleset / custom_proxy_group，确认这是 subconverter 的自定义配置' };
  }

  const groups = [];
  const providers = {};
  const providerByUrl = new Map();
  const rules = [];
  const warnings = [];
  let skipped = 0;
  let providerSeq = 0;

  for (const it of items) {
    if (it.key === 'custom_proxy_group') {
      const g = parseGroup(it.value, warnings);
      if (g) groups.push(g);
      continue;
    }

    // ruleset=目标组,规则体
    const comma = it.value.indexOf(',');
    if (comma < 0) {
      warnings.push(`规则集缺少目标分组，已跳过：${it.value}`);
      skipped += 1;
      continue;
    }
    const target = it.value.slice(0, comma).trim();
    const body = it.value.slice(comma + 1).trim();
    if (!target || !body) {
      skipped += 1;
      continue;
    }

    if (body.startsWith('[]')) {
      const inner = body.slice(2).trim();
      if (!inner) {
        skipped += 1;
        continue;
      }
      rules.push(/^(MATCH|FINAL)$/i.test(inner) ? `MATCH,${target}` : `${inner},${target}`);
      continue;
    }

    const m = /^([a-z0-9-]+):(.+)$/i.exec(body);
    const behavior = m ? behaviorOf(m[1]) : '';
    if (!behavior) {
      warnings.push(`暂不支持的规则集 ${body.split(':')[0]}:，已跳过`);
      skipped += 1;
      continue;
    }
    const url = m[2].trim();
    let key = providerByUrl.get(url);
    if (!key) {
      key = `rs${providerSeq++}`;
      providerByUrl.set(url, key);
      providers[key] = {
        type: 'http',
        behavior,
        url,
        path: `./rules/${key}.yaml`,
        interval: PROVIDER_INTERVAL,
      };
    }
    rules.push(`RULE-SET,${key},${target}`);
  }

  if (!groups.length && !rules.length) {
    return { ok: false, error: '模板里没有可用的分组或规则' };
  }
  if (rules.length > MAX_RULES) {
    return { ok: false, error: `规则条数太多（${rules.length}，上限 ${MAX_RULES}）` };
  }
  // MATCH 必须最后一条，否则后面的规则永远匹配不到
  const finalIdx = rules.findIndex((r) => /^MATCH,/i.test(r));
  if (finalIdx >= 0 && finalIdx !== rules.length - 1) {
    const [final] = rules.splice(finalIdx, 1);
    rules.push(final);
    warnings.push('模板里的 MATCH 不在最后，已移到末尾');
  }

  const template = { 'proxy-groups': groups };
  if (Object.keys(providers).length) template['rule-providers'] = providers;
  template.rules = rules;

  return {
    ok: true,
    template,
    stats: {
      groups: groups.length,
      rules: rules.length,
      providers: Object.keys(providers).length,
      skipped,
    },
    warnings,
  };
}

module.exports = { convert, parseCustom, parseGroup, regexToRef, behaviorOf, MAX_BYTES };
