'use strict';
/**
 * QR 码编码器（ISO/IEC 18004 子集）—— TOTP 绑定二维码用。
 *
 * 零依赖约定：纯位运算，不需要 node:crypto。支持的子集恰好覆盖 otpauth URI：
 *   · 输入按 UTF-8 编码（issuer 可能是中文站名），byte 模式（mode 0100）
 *   · 纠错级别固定 M（约 15% 纠错，屏幕扫码绰绰有余；L 太脆，Q/H 对 URI 是浪费容量）
 *   · 版本 1–10（21×21 ~ 57×57）：ECC M 下 V10 容 216 字节，otpauth URI 再长也够；
 *     超出直接报错，调用方回退「手输密钥」—— 这层失败路径必须留着
 *
 * 不做的事（明确收窄，避免实现面失控）：数字/字母/汉字/混合分段、ECC L/Q/H、
 * 版本 11+、ECI、结构附加（多码拼接）。都是认证器扫码用不到的。
 *
 * 模块矩阵统一 (row, col)，值 true=黑 / false=白，null=未占用。
 */

/* ---------------- 版本参数表（ECC M，V1–V10） ---------------- */

// blocks: [[块数, 每块数据码字], ...]（V8 起出现两种块长）
// rem: 数据码字填完后模块区的零头位（不属于任何码字，固定补 0）——
//      V2–V6 是 7、V7 起归 0（按 jsqr 的功能占位反推核对过）
const ECC_M = [
  { v: 1,  size: 21, ecc: 10, blocks: [[1, 16]],           align: null,        rem: 0 },
  { v: 2,  size: 25, ecc: 16, blocks: [[1, 28]],           align: [6, 18],     rem: 7 },
  { v: 3,  size: 29, ecc: 26, blocks: [[1, 44]],           align: [6, 22],     rem: 7 },
  { v: 4,  size: 33, ecc: 18, blocks: [[2, 32]],           align: [6, 26],     rem: 7 },
  { v: 5,  size: 37, ecc: 24, blocks: [[2, 43]],           align: [6, 30],     rem: 7 },
  { v: 6,  size: 41, ecc: 16, blocks: [[4, 27]],           align: [6, 34],     rem: 7 },
  { v: 7,  size: 45, ecc: 18, blocks: [[4, 31]],           align: [6, 22, 38], rem: 0 },
  { v: 8,  size: 49, ecc: 22, blocks: [[2, 38], [2, 39]],  align: [6, 24, 42], rem: 0 },
  { v: 9,  size: 53, ecc: 22, blocks: [[3, 36], [2, 37]],  align: [6, 26, 46], rem: 0 },
  { v: 10, size: 57, ecc: 26, blocks: [[4, 43], [1, 44]],  align: [6, 28, 50], rem: 0 },
];

/** 各版本数据码字总数（blockCount × dataPerBlock 之和） */
const dataCodewordsOf = (spec) => spec.blocks.reduce((n, [c, d]) => n + c * d, 0);

/* ---------------- GF(256) 运算（Reed-Solomon 用） ---------------- */

// 0x11D 本原多项式下的 exp/log 对数表；log(0) 用 NaN 占位（代码路径不会用到 0 的 log）
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // x *= α (0x02)，溢出 0x100 时模本原多项式 0x11D
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成 n 次纠错多项式 g(x) = ∏(x − α^i)，返回系数数组（高位在前，g[0] 恒为 1） */
function rsGenerator(n) {
  // 高位在前的多项式乘法：poly × (x + α^i)
  //   next[0] = poly[0]；next[j] = poly[j] ^ α^i·poly[j-1]；next[末] = α^i·poly[末]
  // 首版把方向写反了（生成的是互反多项式）：自余校验照样通过，但不是标准 RS 码，
  // 解码器按真 g 去余必然失败 —— 这类「自检发现不了的错」只能靠解码端到端对拍
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    next[0] = poly[0];
    for (let j = 1; j < poly.length; j++) next[j] = poly[j] ^ gmul(poly[j - 1], EXP[i]);
    next[poly.length] = gmul(poly[poly.length - 1], EXP[i]);
    poly = next;
  }
  return poly;
}

/** 求数据多项式除以 g(x) 的余数（纠错码字），返回长度 = n 的数组 */
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const rem = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < n; i++) rem[i] ^= gmul(gen[i + 1], factor);
    }
  }
  return rem;
}

/* ---------------- 位流工具 ---------------- */

class BitBuf {
  constructor() { this.bits = []; }
  push(value, count) {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes(count) {
    // 补齐到字节边界后用 0xEC/0x11 交替填充到 count 个码字（规范要求的 pad）
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      out.push(b);
    }
    let pad = 0xec;
    while (out.length < count) {
      out.push(pad);
      pad = pad === 0xec ? 0x11 : 0xec;
    }
    if (out.length !== count) throw new Error('QR: 数据码字数对不上（内部错误）');
    return out;
  }
}

/* ---------------- 数据编码 ---------------- */

/** 选版本：byte 模式 4 位 mode + 8/16 位长度 + 数据 ≤ 数据码字容量 */
function pickVersion(bytes) {
  for (const spec of ECC_M) {
    const lenBits = spec.v <= 9 ? 8 : 16;
    const dataBytes = dataCodewordsOf(spec);
    if (4 + lenBits + bytes.length * 8 <= dataBytes * 8) return spec;
  }
  throw new Error(`QR: 内容 ${bytes.length} 字节超出 V10-M 容量（216 字节），请改用手输密钥`);
}

/** 按版本分块 → 逐块 RS 纠错 → 交织成最终码字序列 */
function buildCodewords(bytes, spec) {
  const bb = new BitBuf();
  bb.push(0b0100, 4);
  bb.push(bytes.length, spec.v <= 9 ? 8 : 16);
  for (const b of bytes) bb.push(b, 8);
  // terminator：容量内最多 4 个 0，不足则有多少补多少
  const capacityBits = dataCodewordsOf(spec) * 8;
  bb.push(0, Math.min(4, capacityBits - bb.length));

  const data = bb.toBytes(dataCodewordsOf(spec));

  const blocks = [];
  let off = 0;
  for (const [count, per] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(off, off + per);
      off += per;
      blocks.push({ data: chunk, ecc: rsEncode(chunk, spec.ecc) });
    }
  }

  // 交织：数据列优先（短块列尾缺席直接跳过），纠错码字随后统一列交织
  const out = [];
  const maxData = Math.max(...spec.blocks.map(([, d]) => d));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < spec.ecc; i++) {
    for (const b of blocks) out.push(b.ecc[i]);
  }
  return out;
}

/* ---------------- 功能图案 ---------------- */

/** 7×7 定位图案（黑环-白环-黑心）画在 (r0, c0)，含外圈分隔符（白） */
function drawFinder(m, r0, c0) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || c < 0 || r >= m.length || c >= m.length) continue;
      // 距中心切比雪夫距离：0/1=黑心与内环，2=白环，3=黑外环，4=分隔符（白）
      // 写成 `d !== 2` 会把分隔符也涂黑，finder 的 1:1:3:1:1 扫描比率随之失效，
      // 定位阶段直接失败（jsQR 返回 null 的根因）
      const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      m[r][c] = d <= 1 || d === 3;
    }
  }
}

/** 5×5 校正图案画在中心 (cr, cc) */
function drawAlignment(m, cr, cc) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      m[cr + dr][cc + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    }
  }
}

/** 格式信息（15 位 BCH）与版本信息（18 位 BCH） */
function bchRem(dataVal, genPoly, genBits) {
  let rem = dataVal << genBits;
  for (let i = dataVal.toString(2).length + genBits - 1; i >= genBits; i--) {
    if ((rem >>> i) & 1) rem ^= genPoly << (i - genBits);
  }
  return rem;
}

/* ---------------- 掩码与惩罚 ---------------- */

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 规则 1：行/列连续 ≥5 同色。规则 2：2×2 同色块。规则 3：类定位图案。规则 4：黑占比偏离 */
function penalty(m) {
  const size = m.length;
  let score = 0;

  // 规则 1 + 3（行、列各扫一遍）
  const lines = [];
  for (let r = 0; r < size; r++) lines.push(m[r]);
  for (let c = 0; c < size; c++) lines.push(m.map((row) => row[c]));

  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // 规则 3：0000 1011101 或 1011101 0000（含部分重叠命中）
    for (let i = 0; i + 11 <= line.length; i++) {
      let ok1 = true;
      for (let j = 0; j < 11; j++) {
        const want = j === 0 || j === 1 || j === 3 || j === 4 || j === 5 || j === 7 || j === 8 || j === 9 || j === 10;
        if (line[i + j] !== want) { ok1 = false; break; }
      }
      if (ok1) score += 40;
    }
  }

  // 规则 2
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 4
  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/* ---------------- 主流程 ---------------- */

/** 编码文本 → 模块矩阵（boolean[][]，true=黑）。ECC M，自动选版本 1–10。 */
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const spec = pickVersion(bytes);
  const size = spec.size;

  // 1) 功能图案（占位后不再动；null 表示可放数据）
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  drawFinder(m, 0, 0);
  drawFinder(m, 0, size - 7);
  drawFinder(m, size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }
  if (spec.align) {
    // 与三个定位图案重叠的组合要跳过：(6,6)、(6,size-7)、(size-7,6)。
    // 只跳 (6,6) 会多画 2~4 个图案，空位比位流少 50+ 个模块（V2 实测踩过）
    const skip = (cr, cc) =>
      (cr === 6 && cc === 6) || (cr === 6 && cc === size - 7) || (cr === size - 7 && cc === 6);
    for (const cr of spec.align) {
      for (const cc of spec.align) {
        if (skip(cr, cc)) continue;
        drawAlignment(m, cr, cc);
      }
    }
  }
  // 固定暗模块：永远黑，是 format info 副本的分界
  m[size - 8][8] = true;
  // 预留 format / version 区域（占位为 false，稍后写实际值）
  const reserve = (r, c) => { m[r][c] = false; };
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) reserve(8, i);
    if (i !== 6) reserve(i, 8);
  }
  for (let i = 0; i < 8; i++) reserve(8, size - 1 - i);
  for (let i = 0; i < 7; i++) reserve(size - 1 - i, 8);
  if (spec.v >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserve(size - 11 + j, i);
        reserve(i, size - 11 + j);
      }
    }
  }

  // 2) 码字位流（含 rem 个填充 0）
  const codewords = buildCodewords(bytes, spec);
  const bits = [];
  for (const b of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
  }
  for (let i = 0; i < spec.rem; i++) bits.push(0);

  // 3) 蛇形放置（直接写入掩码后的值，掩码只作用于数据模块），
  //    8 个掩码各生成一份，惩罚规则选最优
  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let k = 0; k < 8; k++) {
    const cand = m.map((row) => row.slice());
    const mask = MASKS[k];
    let idx = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      // 第 6 列是 timing 列：整对右移跳过
      if (col === 6) col--;
      for (let i = 0; i < size; i++) {
        const r = upward ? size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (cand[r][c] === null) {
            if (idx >= bits.length) throw new Error('QR: 数据位流短于模块空位（内部错误）');
            // 注意类型：bits 是 0/1 数字，mask 返回 boolean —— number !== boolean 恒真，
            // 写成 `bits[i] !== mask(...)` 会让所有模块全黑（读回只剩棋盘掩码图案）
            cand[r][c] = bits[idx++] !== (mask(r, c) ? 1 : 0);
          }
        }
      }
      upward = !upward;
    }
    if (idx !== bits.length) throw new Error('QR: 数据位流长于模块空位（内部错误）');
    const s = penalty(cand);
    if (s < bestScore) { bestScore = s; best = cand; bestMask = k; }
  }

  // 4) 格式信息（ECC M=00）与版本信息
  writeFormat(best, bestMask);
  if (spec.v >= 7) writeVersion(best, spec.v);
  return best;
}

function writeFormat(m, mask) {
  const size = m.length;
  // ECC M = 00（两位），拼上 3 位掩码，BCH(15,5) 校验，再异或标准掩码 0x5412
  const data = (0b00 << 3) | mask;
  const val = ((data << 10) | bchRem(data, 0x537, 10)) ^ 0x5412;

  // 位序按解码器读取顺序对齐（MSB 在前）。两份副本内容一致，任何一份损坏都可纠
  // 副本 A（左上定位图案周围）：
  //   bit14..9 → (8, 0..5)；bit8 → (8,7)；bit7 → (8,8)；bit6 → (7,8)；bit5..0 → (5..0, 8)
  const putA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  // 副本 B（右下角附近）：bit14..8 → (size-1..size-7, 8)；bit7..0 → (8, size-8..size-1)
  //   注意 col 8 段到 size-7 为止 —— (size-8, 8) 是固定暗模块，绝不能被格式位占用
  const putB = [];
  for (let i = 0; i <= 6; i++) putB.push([size - 1 - i, 8]);
  for (let i = 7; i <= 14; i++) putB.push([8, size - 15 + i]);

  for (let i = 0; i < 15; i++) {
    const bit = ((val >>> (14 - i)) & 1) === 1;
    m[putA[i][0]][putA[i][1]] = bit;
    m[putB[i][0]][putB[i][1]] = bit;
  }
}

function writeVersion(m, v) {
  const size = m.length;
  const val = (v << 12) | bchRem(v, 0x1f25, 12);
  for (let i = 0; i < 18; i++) {
    const bit = ((val >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m[a][b] = bit;
    m[b][a] = bit;
  }
}

/* ---------------- SVG 渲染 ---------------- */

/**
 * 文本 → 可直接内联的二维码 SVG 字符串。
 * scale 是每个模块的视口像素；margin 是四周留白（规范要求 ≥4 个模块的 quiet zone）。
 */
function toSvg(text, { scale = 6, margin = 4 } = {}) {
  const m = encode(text);
  const size = m.length;
  const dim = (size + margin * 2) * scale;
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!m[r][c]) continue;
      const x = (margin + c) * scale;
      const y = (margin + r) * scale;
      d += `M${x} ${y}h${scale}v${scale}h-${scale}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="TOTP 绑定二维码">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`
  );
}

module.exports = { encode, toSvg, ECC_M, rsEncode, rsGenerator, buildCodewords, pickVersion, gmul };
