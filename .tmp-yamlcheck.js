'use strict';
const h = require('./lib/hysteria.js');
const y = h.toYamlFile(
  { id: 't1', name: 't', protocol: 'hysteria2', port: 24578, mode: 'standalone', hy2: {} },
  [{ id: 'u1', uuid: 'x' }],
  't',
  2199,
);
console.log(y.split('\n').filter((l) => l.includes('listen')).join('\n'));