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
 *   --cutlines        在间距正中画裁切线
 *   --format png      输出格式 png | jpeg（默认 png）
 *   --quality 90      jpeg 质量
 *   --prefix sheet    输出文件名前缀（多页自动 -2、-3…）
 *   -o 目录           输出目录（默认当前目录）
 *
 * 不给 --cols/--rows/--cell 时以第一张图的宽高比自动选择「每页张数最多」的排布。
 * 多图非 repeat 模式超出一张纸时自动分页（sheet.png、sheet-2.png…）。
 */
const fs = require('fs');
const path = require('path');
const { buildSheets, PAPERS } = require('../src/sheet');

function usage() {
  console.log(`cardsheet — 图片拼版打印（纸张预设 / 间距 / 裁切线），打印后按格裁切

用法:
  cardsheet <图片...> [选项]

纸张预设: ${Object.keys(PAPERS).join(' / ')}（也可 --sheet 宽x高 毫米直给）
示例:
  cardsheet card.png --paper a4 --repeat --cutlines          # 一张卡片铺满 A4，带裁切线
  cardsheet front.png back.png --paper a4 --cols 2 --rows 5  # 双面卡片各占一页 2×5
  cardsheet p1.png p2.png p3.png --paper 4x6 --landscape --gap 3
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
    else args._.push(a);
  }
  return args;
}

async function main() {
  const [, , ...rest] = process.argv;
  const args = parseArgs(rest);
  const images = args._;
  if (!images.length || args.help || args.h) { usage(); process.exit(images.length ? 0 : 1); }

  const outDir = args.o ? path.resolve(args.o) : process.cwd();
  fs.mkdirSync(outDir, { recursive: true });
  const prefix = String(args.prefix || 'sheet').replace(/[\\/:*?"<>|]/g, '_') || 'sheet';

  const result = await buildSheets({
    images: images.map((p) => ({ buffer: fs.readFileSync(p), name: path.basename(p) })),
    paper: args.sheet || args.paper || 'a4',
    dpi: Number(args.dpi) || 300,
    landscape: !!args.landscape,
    cols: args.cols ? Number(args.cols) : null,
    rows: args.rows ? Number(args.rows) : null,
    cell: args.cell || null,
    gap: args.gap === undefined ? 2 : Number(args.gap),
    margin: args.margin === undefined ? 5 : Number(args.margin),
    repeat: !!args.repeat,
    cutlines: !!args.cutlines,
    format: ['png', 'jpeg'].includes(args.format) ? args.format : 'png',
    quality: Number(args.quality) || 90,
  });

  const written = [];
  result.pages.forEach((buf, i) => {
    const name = `${prefix}${i > 0 ? `-${i + 1}` : ''}.${args.format === 'jpeg' ? 'jpg' : 'png'}`;
    const full = path.join(outDir, name);
    fs.writeFileSync(full, buf);
    written.push(full);
  });
  const cellMmW = (result.cellW / result.dpi * 25.4).toFixed(1);
  const cellMmH = (result.cellH / result.dpi * 25.4).toFixed(1);
  console.log(`✓ ${result.pageCount} 页 → ${written.join(', ')}`);
  console.log(`  画布 ${result.pageW}×${result.pageH}px @${result.dpi}dpi · 每页 ${result.cols} 列 × ${result.rows} 行 = ${result.perPage} 格`);
  console.log(`  单元格 ≈ ${cellMmW}×${cellMmH}mm${args.repeat ? ' · 单图重复铺满' : ''}${args.cutlines ? ' · 已画裁切线' : ''}`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
