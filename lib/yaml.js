'use strict';
/**
 * 极简 YAML 序列化：只覆盖本面板用到的结构（对象 / 数组 / 标量）。
 * Clash 订阅与 Hysteria2 配置共用。
 */

function scalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v === null || v === undefined) return '""';
  const s = String(v);
  if (s === '') return '""';
  // 安全字符直接裸写，其余用 JSON 双引号（JSON 字符串是合法 YAML）
  if (/^[A-Za-z0-9_.\-\/:@+]+$/.test(s) && !/^[\d.]+$/.test(s)) return s;
  if (/^[A-Za-z0-9_.\-\/:@+]+$/.test(s)) return s;
  return JSON.stringify(s);
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
          return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
        }
        return `${pad}${k}: ${scalar(v)}`;
      })
      .join('\n');
  }

  return pad + scalar(value);
}

module.exports = { toYaml };
