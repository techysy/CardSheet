'use strict';
/**
 * cardsheet 冒烟测试：引擎直接调用 + CLI 全链路。
 * 运行：node test/smoke.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { buildSheets, mm2px } = require('../src/sheet');
const { pagesToPdf } = require('../src/pdf');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cardsheet-test-'));
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
const bad = (name, e) => { fail++; console.error(`  ✗ ${name}: ${e.message}`); };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

/** 读某坐标像素（r,g,b） */
async function px(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
async function mean(buf) {
  const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data.reduce((a, v) => a + v, 0) / data.length;
}

async function main() {
  // fixtures：横图（亮）与竖图（暗）
  const imgA = await sharp({ create: { width: 400, height: 250, channels: 3, background: '#e0e0e0' } }).png().toBuffer();
  const imgB = await sharp({ create: { width: 250, height: 400, channels: 3, background: '#303030' } }).png().toBuffer();

  console.log('\n[1] 引擎');
  await t('repeat 模式：单图铺满整页，画布按纸张换算', async () => {
    // 120×80mm @100dpi → 472×315px（120/25.4*100=472.4→472，80→314.96→315）
    const r = await buildSheets({ images: [{ buffer: imgA, name: 'a.png' }], paper: '120x80', dpi: 100, repeat: true, margin: 4, gap: 2 });
    assert.strictEqual(r.pageW, 472);
    assert.strictEqual(r.pageH, 315);
    assert.strictEqual(r.pages.length, 1);
    // 首格中心应为目标底色（灰 224）
    const cx = Math.round(16 + r.cellW / 2), cy = Math.round(16 + r.cellH / 2);
    const [cr, cg, cb] = await px(r.pages[0], cx, cy);
    assert(Math.abs(cr - 224) < 6 && Math.abs(cg - 224) < 6, `首格中心应为图片底色，实际 rgb(${cr},${cg},${cb})`);
  });
  await t('顺序模式：多图逐格、空格留白、超量分页', async () => {
    // 固定几何：120×80mm 页，cell 40x30mm @100dpi（157×118px）→ 2 列 × 2 行 = 4 格
    const r = await buildSheets({
      images: [{ buffer: imgA }, { buffer: imgB }, { buffer: imgA }],
      paper: '120x80', dpi: 100, cell: '40x30', margin: 4, gap: 2,
    });
    assert.strictEqual(r.cols, 2);
    assert.strictEqual(r.rows, 2);
    assert.strictEqual(r.pages.length, 1, '3 图 4 格应一页放下');
    // 第 1 格中心 = 亮图，第 2 格中心 = 暗图（竖图 contain 居中），第 4 格 = 空白
    const [r1] = await px(r.pages[0], 94, 75);
    const [r2] = await px(r.pages[0], 259, 75);
    const [r4] = await px(r.pages[0], 259, 201);
    assert(r1 > 200, `第 1 格应为亮图（${r1}）`);
    assert(r2 < 80, `第 2 格应为暗图（${r2}）`);
    assert(r4 === 255, `第 4 格应留白（${r4}）`);
    // 超量分页：5 图 → 2 页
    const r2p = await buildSheets({
      images: [imgA, imgB, imgA, imgB, imgA].map((b) => ({ buffer: b })),
      paper: '120x80', dpi: 100, cell: '40x30', margin: 4, gap: 2,
    });
    assert.strictEqual(r2p.pages.length, 2, '5 图 4 格应分 2 页');
  });
  await t('自动排布：取每页张数最多，并列取列少者', async () => {
    // 契约：枚举所有列数，取 每页张数 最大 的方案；并列时取列少的（单元格横向更宽）
    // 这里独立把整张表算出来当 oracle，而不是复述引擎的循环 —— 否则两边一起改错照样通过
    const oracle = (paperWmm, paperHmm, aspect, margin, gap) => {
      const pw = mm2px(paperWmm, 100), ph = mm2px(paperHmm, 100);
      const m = mm2px(margin, 100), g = mm2px(gap, 100);
      const maxCols = Math.max(1, Math.floor((pw - 2 * m + g) / (mm2px(15, 100) + g)));
      const table = [];
      for (let c = 1; c <= maxCols; c++) {
        const cw = Math.floor((pw - 2 * m - (c - 1) * g) / c);
        const ch = Math.round(cw / aspect);
        const rows = Math.max(1, Math.floor((ph - 2 * m + g) / (ch + g)));
        table.push({ c, rows, count: c * rows });
      }
      const max = Math.max(...table.map((x) => x.count));
      return table.find((x) => x.count === max); // 表格按列数升序 ⇒ 首个并列者就是列少的
    };

    for (const [label, buf, aspect, paper] of [
      ['A4 方图', await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ccc' } }).png().toBuffer(), 1, [210, 297]],
      ['A4 竖图', imgB, 2 / 3, [210, 297]],
    ]) {
      const want = oracle(paper[0], paper[1], aspect, 5, 2);
      const r = await buildSheets({ images: [{ buffer: buf }], paper: 'a4', dpi: 100, repeat: true });
      assert.strictEqual(r.cols, want.c, `${label}：列数应为 ${want.c}（每页 ${want.count} 张），实际 ${r.cols} 列 × ${r.rows} 行 = ${r.cols * r.rows} 张`);
      assert.strictEqual(r.rows, want.rows, `${label}：行数应为 ${want.rows}，实际 ${r.rows}`);
    }
  });
  await t('contain 居中：竖图进正方格，两侧留白、内容居中', async () => {
    const r = await buildSheets({
      images: [{ buffer: imgB }], paper: '120x80', dpi: 100, cell: '50x50', margin: 4, gap: 2, repeat: true,
    });
    // 竖图 250×400 contain 进 197×197：高贴满、宽 123 居中 → 格子左上角是白底、中心是暗色
    const corner = await px(r.pages[0], 18, 18);
    const [centerR] = await px(r.pages[0], Math.round(16 + 197 / 2), Math.round(16 + 197 / 2));
    assert(corner[0] === 255, `格子角落应留白（${corner}）`);
    assert(centerR < 80, `格子中心应为暗色内容（${centerR}）`);
  });
  await t('裁切线：落在间距正中，颜色为浅灰', async () => {
    // cell 50x50mm、gap 2mm @100dpi：第一列间距中心 x = margin + cellW + gap/2 = 16+197+4 = 217
    const r = await buildSheets({
      images: [{ buffer: imgA }], paper: '120x80', dpi: 100, cell: '50x50', margin: 4, gap: 2,
      repeat: true, cutlines: true,
    });
    const [cr] = await px(r.pages[0], 217, 66);
    assert(Math.abs(cr - 200) < 12, `裁切线应为浅灰 #c8ccd2（${cr}）`);
    // 无裁切线对照：同一位置是白底
    const r2 = await buildSheets({
      images: [{ buffer: imgA }], paper: '120x80', dpi: 100, cell: '50x50', margin: 4, gap: 2, repeat: true,
    });
    const [w] = await px(r2.pages[0], 217, 66);
    assert(w === 255, `无裁切线时同一位置应留白（${w}）`);
  });

  await t('rotate 90：先转后缩，版面按转完的朝向算', async () => {
    // 契约：自动排布用的宽高比必须是「旋转之后」的。imgA 是 400×250 横图，转 90° 就是
    // 250×400 竖图 —— 所以它的版面必须和直接喂 imgB 时一模一样。
    // 若引擎忘了在算宽高比时把 90/270 的宽高互换，这两条结果的行列数就会对不上。
    const turned = await buildSheets({ images: [{ buffer: imgA }], paper: 'a4', dpi: 100, repeat: true, rotate: 90 });
    const native = await buildSheets({ images: [{ buffer: imgB }], paper: 'a4', dpi: 100, repeat: true });
    assert.deepStrictEqual(
      { c: turned.cols, r: turned.rows, w: turned.cellW, h: turned.cellH },
      { c: native.cols, r: native.rows, w: native.cellW, h: native.cellH },
      '横图转 90° 后的版面应与竖图本身一致',
    );
  });
  await t('非法 rotate / fit / position 直接报错，不静默回退', async () => {
    for (const [opt, msg] of [
      [{ rotate: 45 }, 'rotate'],
      [{ fit: 'squish' }, 'fit'],
      [{ position: '中间' }, 'position'],
    ]) {
      await assert.rejects(
        () => buildSheets({ images: [{ buffer: imgA }], paper: 'a4', dpi: 100, repeat: true, ...opt }),
        (e) => { assert(e.message.includes(msg), `错误信息应点明是 ${msg}，实际：${e.message}`); return true; },
      );
    }
  });
  await t('fit cover 铺满格子裁掉溢出；contain + position 按方位贴边', async () => {
    // 竖图 250×400 进 197×197 的方格（cell 50x50mm @100dpi，margin 4mm=16px）
    const m0 = 16, cellPx = 197, midY = 100;
    const cover = await buildSheets({
      images: [{ buffer: imgB }], paper: '120x80', dpi: 100, cell: '50x50', margin: 4, gap: 2,
      repeat: true, fit: 'cover',
    });
    assert((await px(cover.pages[0], m0 + 2, m0 + 2))[0] < 80, 'cover 下格子角落应仍是图片内容，没有留白');

    // contain + left：内容贴左边缘，右边缘留白（默认居中时内容是居中的）
    const left = await buildSheets({
      images: [{ buffer: imgB }], paper: '120x80', dpi: 100, cell: '50x50', margin: 4, gap: 2,
      repeat: true, position: 'left',
    });
    assert((await px(left.pages[0], m0 + 2, midY))[0] < 80, 'position=left 时内容应贴住左边缘');
    assert((await px(left.pages[0], m0 + cellPx - 2, midY))[0] === 255, 'position=left 时右边缘应留白');
  });
  await t('PDF：多页装进一个文件，页数与纸张尺寸都对得上', async () => {
    // 5 图 4 格 → 2 页；120×80mm @100dpi = 472×315px
    const r = await buildSheets({
      images: [imgA, imgB, imgA, imgB, imgA].map((b) => ({ buffer: b })),
      paper: '120x80', dpi: 100, cell: '40x30', margin: 4, gap: 2, format: 'jpeg',
    });
    assert.strictEqual(r.pages.length, 2, '5 图 4 格应分 2 页');
    const pdf = await pagesToPdf(r.pages, { width: r.pageW, height: r.pageH, dpi: r.dpi });
    assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-', '应是一个 PDF 文件');

    // 反解回来核对：用 PDFDocument 读回，页数与页面尺寸（px × 72/dpi = pt）必须对得上
    const doc = await PDFDocument.load(pdf);
    assert.strictEqual(doc.getPageCount(), 2, 'PDF 页数应与页面数一致');
    const size = doc.getPage(0).getSize();
    assert(Math.abs(size.width - 472 * 0.72) < 0.5, `页宽应为 ${472 * 0.72}pt，实际 ${size.width}`);
    assert(Math.abs(size.height - 315 * 0.72) < 0.5, `页高应为 ${315 * 0.72}pt，实际 ${size.height}`);
  });

  console.log('\n[2] CLI 全链路');
  await t('cardsheet --repeat --cutlines 出图', async () => {
    const a = path.join(TMP, 'card.png');
    fs.writeFileSync(a, imgA);
    const outDir = path.join(TMP, 'out');
    const r = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'cardsheet.js'), a,
      '--sheet', '120x80', '--dpi', '100', '--repeat', '--cutlines', '-o', outDir,
    ], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `CLI 退出码 ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = path.join(outDir, 'sheet.png');
    assert(fs.existsSync(out), '输出缺失');
    const m = await sharp(fs.readFileSync(out)).metadata();
    assert.strictEqual(m.width, 472);
    assert.strictEqual(m.height, 315);
  });
  await t('cardsheet --format pdf 出单个文件，多页合成一页组', async () => {
    const a = path.join(TMP, 'front.png');
    const b = path.join(TMP, 'back.png');
    fs.writeFileSync(a, imgA);
    fs.writeFileSync(b, imgB);
    const outDir = path.join(TMP, 'out-pdf');
    const r = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'cardsheet.js'), a, b, a, b, a,
      '--sheet', '120x80', '--dpi', '100', '--cell', '40x30', '--margin', '4',
      '--rotate', '90', '--format', 'pdf', '-o', outDir,
    ], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `CLI 退出码 ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = path.join(outDir, 'sheet.pdf');
    assert(fs.existsSync(out), '输出缺失');
    // PDF 模式下只应有一个文件，不能同时留一堆中间 png/jpg
    assert.deepStrictEqual(fs.readdirSync(outDir), ['sheet.pdf'], 'PDF 模式不应留下中间页文件');
    const doc = await PDFDocument.load(fs.readFileSync(out));
    assert.strictEqual(doc.getPageCount(), 2, '5 图 4 格应装成 2 页 PDF');
  });

  console.log(`\n结果：${pass} 通过，${fail} 失败  （fixtures 保留在 ${TMP}）`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
