'use strict';
/**
 * 极简 YAML 序列化：只覆盖本面板用到的结构（对象 / 数组 / 标量）。
 * Clash 订阅与 Hysteria2 配置共用。
 */

// 裸写安全字符：首字符必须是字母/数字/下划线（`@`、`` ` ``、`:` 开头在 YAML 里是保留指示符），
// 其余位允许主机名与 URL 里常见的字符
const SAFE_BARE = /^[A-Za-z0-9_][A-Za-z0-9_.\-\/:@+]*$/;
// 会被解析成 int / float 的写法（含 1e3、.5、1_000、0x1f）—— 必须加引号
const LOOKS_NUMERIC = /^[+-]?(?:0x[0-9a-fA-F]+|(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;
// 裸日期在 YAML 1.1 里是 timestamp（yaml.v3 也认一部分写法）—— 节点名带日期时会被解析成别的东西
const LOOKS_DATE = /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt\s].*)?$/;
// 以冒号结尾的裸标量会被当成「紧凑映射」的开头：`name: a:` 直接解析报错，
// 整份订阅因此加载失败（实测 yaml 包报 "Nested mappings are not allowed"）。
// `a:b`、`host:443` 这类中间带冒号的是合法裸标量，不受影响。
const ENDS_WITH_COLON = /:$/;
// YAML 1.1 的布尔 / 空值裸词。mihomo 用 yaml.v3（1.2 core）只认 true/false/null，
// 但订阅可能被第三方转换器（subconverter 等）用 1.1 解析器再读一遍，
// 而 `name: on` 在 1.1 里是 boolean —— 名字变成布尔值，分组引用全部对不上
const RESERVED = new Set([
  'null', 'Null', 'NULL', '~',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'yes', 'Yes', 'YES', 'no', 'No', 'NO',
  'on', 'On', 'ON', 'off', 'Off', 'OFF',
  'y', 'Y', 'n', 'N',
]);

function scalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v === null || v === undefined) return '""';
  const s = String(v);
  if (s === '') return '""';
  // 安全字符直接裸写，其余用 JSON 双引号（JSON 字符串是合法 YAML）
  if (SAFE_BARE.test(s) && !LOOKS_NUMERIC.test(s) && !LOOKS_DATE.test(s) && !ENDS_WITH_COLON.test(s) && !RESERVED.has(s)) return s;
  return JSON.stringify(s);
}

/**
 * 对象 key。当前所有 key 都是代码里的字面量，但这里不省这道校验 ——
 * 将来任何一处把用户输入当 key 用（比如自定义规则的字段名），裸写就是注入面。
 */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
function yamlKey(k) {
  return SAFE_KEY.test(k) ? k : JSON.stringify(k);
}

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return pad + '[]';
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const body = toYaml(item, indent + 2);
          return pad + '- ' + body.trimStart();
        }
        return pad + '- ' + scalar(item);
      })
      .join('\n');
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return pad + '{}';
    return entries
      .map(([k, v]) => {
        if (v && typeof v === 'object') {
          return `${pad}${yamlKey(k)}:\n${toYaml(v, indent + 2)}`;
        }
        return `${pad}${yamlKey(k)}: ${scalar(v)}`;
      })
      .join('\n');
  }

  return pad + scalar(value);
}

module.exports = { toYaml };
