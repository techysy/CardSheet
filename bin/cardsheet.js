#!/usr/bin/env node
'use strict';
/**
 * cardsheet — 把若干图片拼到一张可打印的大图上（拼版/拆件）。
 *
 * 典型场景：一张卡片设计（饮品介绍 / 名片）打印后裁切成一小张一小张。
 *
 * 用法:
 *   cardsheet <图片...> [选项]
 *
 * 选项:
 *   --paper a4        纸张预设：a4 / a5 / a3 / b5 / 4x6 / 5x7 / card（名片 86x54）
 *   --sheet 210x297   直接指定纸张尺寸（毫米），优先于 --paper
 *   --landscape       纸张横放
 *   --dpi 300         输出分辨率（默认 300，打印级）
 *   --cols 2          每行个数；--rows 5 每列（每页）行数
 *   --cell 86x54      固定单元格尺寸（毫米）；行列数按纸张反推
 *   --gap 2           单元格间距（毫米，默认 2）
 *   --margin 5        页边距（毫米，默认 5）
 *   --repeat          用第一张图铺满整页（同一张卡片拼版的场景）
 *   --cutlines [solid|dashed]  在间距正中画裁切线；裸写（不带样式）等同 solid
 *   --cutline-color #e2e5ea  自定义裁切线颜色，不给则用样式默认色（虚线比实线更浅）
 *   --rotate 90       每张图先顺时针转 0/90/180/270（默认 0）
 *   --fit contain     缩放方式：contain 完整放入 / cover 铺满裁掉溢出 / fill 拉伸变形（默认 contain）
 *   --position centre  cover 时的对齐方式，如 top / left bottom（默认 centre）
 *   --format png      输出格式 png | jpeg | pdf（默认 png；pdf 是把各页装进一个文件）
 *   --quality 90      jpeg 质量（--format pdf 时是页内嵌图的 jpeg 质量）
 *   --prefix sheet    输出文件名前缀（多页自动 -2、-3…）
 *   -o 目录           输出目录（默认当前目录）
 *
 * 不给 --cols/--rows/--cell 时以第一张图的宽高比自动选择「每页张数最多」的排布。
 * 多图非 repeat 模式超出一张纸时自动分页（sheet.png、sheet-2.png…）。
 */
const fs = require('fs');
const path = require('path');
const { buildSheets, PAPERS } = require('../src/sheet');
const { pagesToPdf } = require('../src/pdf');

/** 严格解析数值参数，支持负数检测 */
function parsePositiveNumber(val, name) {
  const n = Number(val);
  if (isNaN(n)) throw new Error(`${name} 必须为数字：${val}`);
  if (n < 0) throw new Error(`${name} 不能为负数：${val}`);
  return n;
}

/**
 * 解析「个数」类参数（--cols / --rows）：必须是显式给出的正整数。
 *
 * 裸写 `--cols`（不带值）时 parseArgs 会把它置为布尔 true，而 `Number(true) === 1`，
 * 于是 parsePositiveNumber 会把缺值的 flag 悄悄当成「1 列」。这里单独拦掉。
 */
function parseCount(val, name) {
  if (val === true) throw new Error(`--${name} 需要一个正整数，例：--${name} 3`);
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} 必须是正整数，收到：${val}`);
  return n;
}

function usage() {
  console.log(`cardsheet — 图片拼版打印（纸张预设 / 间距 / 裁切线），打印后按格裁切

用法:
  cardsheet <图片...> [选项]

纸张预设: ${Object.keys(PAPERS).join(' / ')}（也可 --sheet 宽x高 毫米直给）
示例:
  cardsheet card.png --paper a4 --repeat --cutlines          # 一张卡片铺满 A4，带裁切线
  cardsheet front.png back.png --paper a4 --cols 2 --rows 5  # 双面卡片各占一页 2×5
  cardsheet p1.png p2.png p3.png --paper 4x6 --landscape --gap 3
  cardsheet scan.jpg --rotate 90 --fit cover --cutlines     # 转正后铺满裁掉溢出
  cardsheet card.png --repeat --cutlines dashed             # 只要很浅的虚线做裁切标记
  cardsheet *.png --paper a4 --format pdf --prefix 名片     # 多页装进一个 PDF
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--') || (next.startsWith('-') && next !== '-' && isNaN(Number(next)))) {
        args[key] = true;
      } else { args[key] = next; i++; }
    } else if (a === '-o') { args.o = argv[++i]; }
    // -h 之前没在这里接住，被当成图片文件名推进 _ 里了 —— 于是 main() 里那句
    // `args.h` 永远是 undefined，`cardsheet -h` 会去读一个叫 "-h" 的文件然后报错
    else if (a === '-h') { args.h = true; }
    else args._.push(a);
  }
  return args;
}

async function main() {
  const [, , ...rest] = process.argv;
  const args = parseArgs(rest);
  const images = args._;
  // --help 问的是「怎么用」，不是用法错误，退 0；什么都不给才是退 1。
  // 两者写在同一个条件里时，`cardsheet --help` 会落进 images.length === 0 那支退 1 ——
  // release.yml 的三平台试装正好跑 `npx cardsheet --help`，第一版就是这么挂的。
  if (args.help || args.h) { usage(); process.exit(0); }
  if (!images.length) { usage(); process.exit(1); }

  // 创建输出目录并校验权限
  const outDir = args.o ? path.resolve(args.o) : process.cwd();
  try {
    fs.mkdirSync(outDir, { recursive: true });
    // 测试写入权限
    const testFile = path.join(outDir, '.cardsheet_write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch (e) {
    throw new Error(`无法写入目录 "${outDir}": ${e.message}`);
  }

  const prefix = String(args.prefix || 'sheet').replace(/[\\/:*?"<>|]/g, '_') || 'sheet';

  // 格式非法直接报错，别悄悄退回 png —— 拼完版发现拿到的是 png，是很难查的一类错
  const fmt = String(args.format || 'png').toLowerCase();
  if (!['png', 'jpeg', 'pdf'].includes(fmt)) {
    throw new Error(`--format 仅支持 png / jpeg / pdf，收到：${args.format}`);
  }
  // PDF 里装的仍是页面图像，所以引擎那边照旧出图；用 jpeg 是因为 PDF 原生嵌 JPEG 体积最小，
  // 且不引入第二次转码（见 src/pdf.js）
  const engineFormat = fmt === 'pdf' ? 'jpeg' : fmt;

  // 构建参数对象，添加严格校验
  const sheetOpts = {
    images: images.map((p) => {
      let buf;
      try {
        buf = fs.readFileSync(p);
      } catch (e) {
        throw new Error(`无法读取图片 "${p}": ${e.message}`);
      }
      return { buffer: buf, name: path.basename(p) };
    }),
    paper: args.sheet || args.paper || 'a4',
    dpi: parsePositiveNumber(args.dpi ?? 300, 'dpi'),
    landscape: !!args.landscape,
    cols: args.cols !== undefined ? parseCount(args.cols, 'cols') : null,
    rows: args.rows !== undefined ? parseCount(args.rows, 'rows') : null,
    cell: args.cell || null,
    gap: args.gap === undefined ? 2 : parsePositiveNumber(args.gap, 'gap'),
    margin: args.margin === undefined ? 5 : parsePositiveNumber(args.margin, 'margin'),
    repeat: !!args.repeat,
    // 裸写 --cutlines → true；`--cutlines dashed` → 'dashed'，两种引擎都认
    cutlines: args.cutlines === undefined ? false : args.cutlines,
    cutlineColor: args['cutline-color'] || null,
    rotate: args.rotate === undefined ? 0 : parsePositiveNumber(args.rotate, 'rotate'),
    fit: args.fit || 'contain',
    position: args.position || 'centre',
    format: engineFormat,
    quality: parsePositiveNumber(args.quality ?? 90, 'quality'),
  };

  const result = await buildSheets(sheetOpts);

  const written = [];
  if (fmt === 'pdf') {
    const pdf = await pagesToPdf(result.pages, {
      width: result.pageW, height: result.pageH, dpi: result.dpi,
    });
    const full = path.join(outDir, `${prefix}.pdf`);
    fs.writeFileSync(full, pdf);
    written.push(full);
  } else {
    const ext = engineFormat === 'jpeg' ? 'jpg' : 'png';
    result.pages.forEach((buf, i) => {
      const full = path.join(outDir, `${prefix}${i > 0 ? `-${i + 1}` : ''}.${ext}`);
      fs.writeFileSync(full, buf);
      written.push(full);
    });
  }
  const cellMmW = (result.cellW / result.dpi * 25.4).toFixed(1);
  const cellMmH = (result.cellH / result.dpi * 25.4).toFixed(1);
  const extras = [
    args.repeat ? '单图重复铺满' : '',
    args.cutlines ? `已画${args.cutlines === 'dashed' ? '虚' : ''}裁切线` : '',
    sheetOpts.rotate ? `已旋转 ${sheetOpts.rotate}°` : '',
    sheetOpts.fit !== 'contain' ? `填充 ${sheetOpts.fit}` : '',
  ].filter(Boolean).join(' · ');
  console.log(`✓ ${result.pageCount} 页 → ${written.join(', ')}`);
  console.log(`  画布 ${result.pageW}×${result.pageH}px @${result.dpi}dpi · 每页 ${result.cols} 列 × ${result.rows} 行 = ${result.perPage} 格`);
  console.log(`  单元格 ≈ ${cellMmW}×${cellMmH}mm${extras ? ` · ${extras}` : ''}`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
