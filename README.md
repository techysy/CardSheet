# cardsheet

把若干图片拼到一张可打印的大图上（拼版 / 拆件）：按常见纸张预设换算像素，单元格间距与页边距按毫米计，可在间距正中画裁切线 —— 打印后按格裁切。

典型场景：一张卡片设计（饮品介绍、名片）要打印后拆成一小张一小张 —— 用 `--repeat` 让它铺满整张 A4。

## 安装

```bash
npm install
```

## 用法

```bash
node bin/cardsheet.js <图片...> [选项]
```

| 选项 | 说明 |
| --- | --- |
| `--paper a4` | 纸张预设：`a4 / a5 / a3 / b5 / 4x6 / 5x7 / card`（名片 86×54mm） |
| `--sheet 210x297` | 直接指定纸张尺寸（毫米），优先于 `--paper` |
| `--landscape` | 纸张横放 |
| `--dpi 300` | 输出分辨率（默认 300，打印级） |
| `--cols 2` / `--rows 5` | 每行 / 每列个数 |
| `--cell 86x54` | 固定单元格尺寸（毫米），行列数按纸张反推 |
| `--gap 2` | 单元格间距（毫米，默认 2） |
| `--margin 5` | 页边距（毫米，默认 5） |
| `--repeat` | 用第一张图铺满整页（同一张卡片拼版） |
| `--cutlines` | 在间距正中画浅灰裁切线 |
| `--format png` | `png` / `jpeg` |
| `-o 目录` | 输出目录（默认当前目录） |

不给 `--cols/--rows/--cell` 时，以第一张图的宽高比自动选择「每页张数最多」的排布；
横图 / 竖图自动 contain 居中进单元格。多图（非 repeat）超出一张纸时自动分页
（`sheet.png`、`sheet-2.png`…）。

## 示例

```bash
# 一张饮品卡片铺满 A4，带裁切线（300dpi 打印级）
node bin/cardsheet.js card.png --paper a4 --repeat --cutlines

# A4 摆 2×5 张 86×54mm 名片，正反面各一页
node bin/cardsheet.js front.png back.png --cell 86x54 --paper a4 --repeat --cutlines

# 4×6 相纸横放，三张样片按顺序排
node bin/cardsheet.js p1.png p2.png p3.png --paper 4x6 --landscape --gap 3
```

## 引擎单独使用

```bash
node -e "require('./src/sheet').buildSheets({...})"
```

`buildSheets` 返回 `{ pages: Buffer[], pageW, pageH, cols, rows, cellW, cellH, perPage, pageCount, dpi }`。

## 测试

```bash
npm test
```
