'use strict';
/**
 * cardsheet 排版引擎：把若干图片拼到一张（或多张）可打印的大图上。
 *
 * 场景：一张卡片设计（如饮品介绍）要打印后裁切成一小张一小张 ——
 * 按纸张预设（A4/相纸/名片尺寸）+ dpi 换算出画布像素，把图片按
 * 列数×行数 contain 居中摆进单元格，间距与页边距按毫米计，可在间距正中画裁切线。
 *
 * 管线形状与「逐图加水印」不同：这里是 N 张进 → 1 张出（超量的图自动分页）。
 *
 * 本模块只吐图片（PNG / JPEG）。PDF 封装在 src/pdf.js，是引擎之上的可选一层。
 */
const sharp = require('sharp');

/** 常见纸张/相纸/名片尺寸（毫米，竖向 宽×高） */
const PAPERS = {
  a4: [210, 297],
  a5: [148, 210],
  a3: [297, 420],
  b5: [176, 250],
  '4x6': [101.6, 152.4],  // 4×6 英寸相纸
  '5x7': [127, 177.8],    // 5×7 英寸相纸
  card: [86, 54],         // 标准名片
};

const mm2px = (v, dpi) => Math.max(1, Math.round((v / 25.4) * dpi));

/** sharp 的 position 白名单（'center' 是 sharp 自己不认的别名，进来时归一化掉） */
const FIT_POSITIONS = ['top', 'right top', 'right', 'right bottom', 'bottom', 'left bottom', 'left', 'left top', 'centre', 'entropy', 'attention'];

/** 原图的宽高比；rotate 为 90/270 时宽高互换 */
function aspectOf(meta, rotate) {
  const w = meta.width || 3, h = meta.height || 2;
  return rotate % 180 === 0 ? w / h : h / w;
}

/** 'a4' 预设 或 '210x297'（毫米）；landscape 交换宽高。返回 [宽mm, 高mm] */
function resolvePaper(spec, landscape) {
  let wh = PAPERS[String(spec || '').toLowerCase()];
  if (!wh) {
    const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(String(spec || ''));
    if (!m) {
      throw new Error(`未知纸张 "${spec || '(空)'}"；可用预设：${Object.keys(PAPERS).join(' / ')}，或直接给 宽x高（毫米，如 210x297）`);
    }
    wh = [Number(m[1]), Number(m[2])];
  }
  return landscape ? [wh[1], wh[0]] : wh;
}

/** '86x54' → [86, 54]（毫米） */
function parseWxH(spec, what) {
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(String(spec || ''));
  if (!m) throw new Error(`${what} 应为 宽x高（毫米，如 86x54），收到: ${spec}`);
  return [Number(m[1]), Number(m[2])];
}

/** 间距正中的裁切线：列间竖线、行间横线，浅灰；线宽随 dpi（约 0.17mm）并取整像素画 rect
 * 简单可靠的 SVG 实现 */
function cutlineSvg(pw, ph, m, nCols, nRows, cellW, cellH, g, dpi) {
  const wLine = Math.max(1, Math.round(dpi / 150));
  let parts = '';
  for (let c = 1; c < nCols; c++) {
    const cx = m + c * (cellW + g) - g / 2;
    const x0 = Math.round(cx - wLine / 2);
    parts += `<rect x="${x0}" y="${m}" width="${wLine}" height="${ph - 2 * m}" fill="#c8ccd2"/>`;
  }
  for (let r = 1; r < nRows; r++) {
    const cy = m + r * (cellH + g) - g / 2;
    const y0 = Math.round(cy - wLine / 2);
    parts += `<rect x="${m}" y="${y0}" width="${pw - 2 * m}" height="${wLine}" fill="#c8ccd2"/>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">${parts}</svg>`);
}

/**
 * 拼版。
 * @param {object} o
 *   images   [{buffer, name}] 图片列表（顺序即排布顺序）
 *   paper    纸张预设名或 '宽x高'（毫米，默认 'a4'）
 *   dpi      输出分辨率（默认 300，打印级）
 *   landscape 纸张横放
 *   cols/rows 每行/每列个数；cell '宽x高'（毫米）固定单元格 —— 三者给法：
 *             cell 给定 → 行列按纸张反推；cols+rows 同给 → 单元格平分；都不给 →
 *             以第一张图宽高比枚举列数，取「每页张数最多」的方案
 *   gap      单元格间距（毫米，默认 2）
 *   margin   页边距（毫米，默认 5）
 *   repeat   用第一张图铺满整页（同一张卡片拼版）；不给则按顺序逐格排，超量自动分页
 *   cutlines 在间距正中画裁切线
 *   rotate   每张图先顺时针转 0/90/180/270（默认 0）。会改变宽高比，自动排布按转完之后的朝向算
 *   fit      contain 完整放进格子（留白填背景色）| cover 铺满格子并裁掉溢出 | fill 拉伸变形铺满（默认 contain）
 *   position cover/contain 时的对齐方式，如 top / left / centre（默认 centre）
 *   background 页面底色（默认白）
 *   format   png|jpeg 输出格式；quality jpeg 质量
 * @returns {{pages:Buffer[], pageW,pageH, cols,rows, cellW,cellH, perPage, pageCount}}
 */
async function buildSheets(o = {}) {
  const {
    images, paper = 'a4', dpi = 300, landscape = false,
    cols = null, rows = null, cell = null,
    gap = 2, margin = 5,
    repeat = false, cutlines = false,
    rotate = 0, fit = 'contain', position = 'centre',
    background = '#ffffff', format = 'png', quality = 90,
  } = o;
  if (!Array.isArray(images) || !images.length) throw new Error('未提供图片');

  // dpi 夹在 [36, 1200]：太低的没法打印，太高的画布像素会失控
  const dpiN = Math.max(36, Math.min(1200, Number(dpi) || 300));

  // 旋转/缩放模式/对齐方式都是白名单：非法值直接报错，而不是悄悄回退到默认值让人拿到错图
  const rot = Number(rotate) || 0;
  if (![0, 90, 180, 270].includes(rot)) throw new Error(`rotate 仅支持 0/90/180/270，收到：${rotate}`);
  const fitMode = String(fit).toLowerCase();
  if (!['contain', 'cover', 'fill'].includes(fitMode)) throw new Error(`fit 仅支持 contain/cover/fill，收到：${fit}`);
  const posIn = String(position).toLowerCase();
  if (!FIT_POSITIONS.includes(posIn)) throw new Error(`position 仅支持 ${FIT_POSITIONS.join(' / ')}，收到：${position}`);
  const pos = posIn === 'center' ? 'centre' : posIn;
  const [paperWmm, paperHmm] = resolvePaper(paper, landscape);
  const pw = mm2px(paperWmm, dpiN);
  const ph = mm2px(paperHmm, dpiN);
  const gapN = Number(gap);
  const marginN = Number(margin);
  const g = mm2px(gapN < 0 ? 0 : gapN, dpiN);
  const m = mm2px(marginN < 0 ? 0 : marginN, dpiN);
  if (pw - 2 * m < 20 || ph - 2 * m < 20) throw new Error('页边距过大，可用版面不足 20px');

  // 单元格与行列数（px）
  let cellW, cellH, nCols, nRows;
  if (cell) {
    const [cwm, chm] = parseWxH(cell, 'cell');
    cellW = mm2px(cwm, dpiN);
    cellH = mm2px(chm, dpiN);
    nCols = cols || Math.max(1, Math.floor((pw - 2 * m + g) / (cellW + g)));
    nRows = rows || Math.max(1, Math.floor((ph - 2 * m + g) / (cellH + g)));
  } else if (cols && rows) {
    nCols = cols; nRows = rows;
    cellW = Math.floor((pw - 2 * m - (nCols - 1) * g) / nCols);
    cellH = Math.floor((ph - 2 * m - (nRows - 1) * g) / nRows);
  } else if (cols || rows) {
    // 只给一个方向：另一方向以首图宽高比推（按旋转后的朝向，否则转 90° 的图会按原比例算行数）
    const aspect = aspectOf(await sharp(images[0].buffer).metadata(), rot);
    if (cols) {
      nCols = cols;
      cellW = Math.floor((pw - 2 * m - (nCols - 1) * g) / nCols);
      cellH = Math.round(cellW / aspect);
      nRows = Math.max(1, Math.floor((ph - 2 * m + g) / (cellH + g)));
    } else {
      nRows = rows;
      cellH = Math.floor((ph - 2 * m - (nRows - 1) * g) / nRows);
      cellW = Math.round(cellH * aspect);
      nCols = Math.max(1, Math.floor((pw - 2 * m + g) / (cellW + g)));
    }
  } else {
    // 全自动：以首图宽高比枚举列数（单元格最窄 15mm），取每页张数最多的方案（并列取列少者）
    const aspect = aspectOf(await sharp(images[0].buffer).metadata(), rot);
    const minCell = mm2px(15, dpiN);
    const maxCols = Math.max(1, Math.floor((pw - 2 * m + g) / (minCell + g)));
    let best = null;
    // 从少到多枚举列数。这里刻意不做提前退出：count 在整个区间内单调递增（列越多、
    // 单元格越窄、每页张数越多），最优解总在末位 c = maxCols，提前退出既无收益，
    // 退出条件还得额外论证单调性才敢信。枚举量本身只有几十次。
    for (let c = 1; c <= maxCols; c++) {
      const cw = Math.floor((pw - 2 * m - (c - 1) * g) / c);
      const chh = Math.round(cw / aspect);
      const r = Math.max(1, Math.floor((ph - 2 * m + g) / (chh + g)));
      const count = c * r;
      // 严格大于 ⇒ 并列时保留先遇到的，也就是列少的那个
      if (!best || count > best.count) {
        best = { c, r, cw, ch: chh, count };
      }
    }
    if (!best) throw new Error('无法计算版面：请检查纸张/间距设置');
    nCols = best.c; nRows = best.r; cellW = best.cw; cellH = best.ch;
  }
  if (cellW < 8 || cellH < 8) throw new Error('单元格尺寸过小（<8px），请检查纸张/行列/间距设置');

  const perPage = nCols * nRows;
  const seq = repeat ? Array.from({ length: perPage }, () => images[0]) : images.slice();
  const pageCount = repeat ? 1 : Math.max(1, Math.ceil(seq.length / perPage));

  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const pageImgs = seq.slice(p * perPage, (p + 1) * perPage);
    const comps = [];
    for (let i = 0; i < pageImgs.length; i++) {
      const c = i % nCols, r = Math.floor(i / nCols);
      // 先转再缩：sharp 的流水线固定是 rotate 在 resize 之前，转完的宽高比才对得上单元格
      // contain 完整放进格子（留白填背景色）/ cover 铺满并裁掉溢出 / fill 拉伸变形铺满
      let pipe = sharp(pageImgs[i].buffer);
      if (rot) pipe = pipe.rotate(rot);
      const buf = await pipe
        .resize(cellW, cellH, { fit: fitMode, position: pos, background })
        .png().toBuffer();
      comps.push({ input: buf, left: m + c * (cellW + g), top: m + r * (cellH + g) });
    }
    if (cutlines) comps.push({ input: cutlineSvg(pw, ph, m, nCols, nRows, cellW, cellH, g, dpiN), left: 0, top: 0 });
    const pipeline = sharp({ create: { width: pw, height: ph, channels: 3, background } }).composite(comps);
    pages.push(await (String(format).toLowerCase() === 'jpeg' ? pipeline.jpeg({ quality: Number(quality) || 90 }) : pipeline.png()).toBuffer());
  }
  return { pages, pageW: pw, pageH: ph, cols: nCols, rows: nRows, cellW, cellH, perPage, pageCount, dpi: dpiN };
}

module.exports = { buildSheets, resolvePaper, PAPERS, mm2px };
