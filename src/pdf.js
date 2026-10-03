'use strict';
/**
 * 把 buildSheets 出的页面 Buffer[] 封装成一个 PDF。
 *
 * 单独成模块而不是塞进 buildSheets，是因为排版和容器格式是两件事：
 * 引擎只管「像素怎么摆」，PDF 只管「这些像素怎么装进一个文件」。
 * 换输出格式（PNG/JPEG）不需要碰 PDF 这层，加 PDF 也不需要碰版面算法。
 *
 * 页面按原样嵌入，不重新编码：JPEG 走 PDF 原生的 DCTDecode，PNG 走 FlateDecode。
 * 少一次转码就少一次画质损失，也少一份内存峰值。
 */
const { PDFDocument } = require('pdf-lib');

/** 认魔数决定走 embedPng 还是 embedJpg，比看扩展名可靠（调用方给的可能是任意 Buffer） */
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  throw new Error('PDF 只能嵌入 PNG 或 JPEG 页面');
}

/**
 * 页面像素 → PDF 点。PDF 用户单位是 1/72 英寸，而这里的像素是按 dpi 定义的，
 * 所以 1px = 72/dpi pt。整套毫米↔像素↔点的换算只在边界上做这一次。
 */
const px2pt = (px, dpi) => (px * 72) / dpi;

/**
 * @param {Buffer[]} pages 页面图像（PNG 或 JPEG 混用亦可）
 * @param {object} o
 *   width  页面宽（像素）—— 所有页必须同宽
 *   height 页面高（像素）
 *   dpi    这些像素对应的分辨率，用来把像素换成 PDF 的点
 *   title  可选，写进 PDF 元数据
 * @returns {Promise<Buffer>}
 */
async function pagesToPdf(pages, o = {}) {
  const { width, height, dpi = 300, title = 'cardsheet' } = o;
  if (!Array.isArray(pages) || !pages.length) throw new Error('没有可封装的页面');
  if (!(width > 0) || !(height > 0)) throw new Error('pagesToPdf 需要 width / height（像素）');
  const ptW = px2pt(width, dpi), ptH = px2pt(height, dpi);

  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('cardsheet');
  doc.setCreator('cardsheet');

  for (const [i, buf] of pages.entries()) {
    let image;
    try {
      image = sniff(buf) === 'png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
    } catch (e) {
      throw new Error(`第 ${i + 1} 页无法嵌入 PDF：${e.message}`);
    }
    // PDF 原点在左下角、y 轴朝上，我们是整页满铺，所以不需要翻转
    doc.addPage([ptW, ptH]).drawImage(image, { x: 0, y: 0, width: ptW, height: ptH });
  }
  return Buffer.from(await doc.save());
}

module.exports = { pagesToPdf, px2pt };
