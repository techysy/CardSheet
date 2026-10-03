# cardsheet

把若干图片拼到一张可打印的大图上（拼版 / 拆件）：按常见纸张预设换算像素，单元格间距与页边距按毫米计，可在间距正中画裁切线 —— 打印后按格裁切。

典型场景：一张卡片设计（饮品介绍、名片）要打印后拆成一小张一小张 —— 用 `--repeat` 让它铺满整张 A4。

零配置、零依赖服务、单一运行时依赖（[sharp](https://sharp.pixelplumbing.com/)），单条命令出图。

## 功能

- **纸张预设**：A4 / A5 / A3 / B5 / 4×6 / 5×7 相纸 / 标准名片，也可 `--sheet 210x297` 直接给毫米
- **四种排布给法**：固定单元格、固定行列、单向推算、全自动「每页塞最多」，详见[版面求解](#版面求解)
- **毫米进、像素算**：对外全是毫米，引擎内部只做一次 `mm2px` 换算，杜绝舍入误差在几何里累积
- **自动分页**：图多于一页时自动切 `sheet.png` / `sheet-2.png` / `sheet-3.png`…
- **裁切线**：`--cutlines` 在间距正中画实心浅灰线，打印可见、裁得准
- **打印级输出**：默认 300 dpi，可调 36–1200
- **两种用法**：命令行，或把 `buildSheets()` 当模块嵌进别的程序

## 🏗️ 架构

> 深色模式看 [`docs/architecture.svg`](docs/architecture.svg)，浅色模式看 [`docs/architecture-light.svg`](docs/architecture-light.svg)；版面求解决策树见 [`docs/layout.svg`](docs/layout.svg) / [`docs/layout-light.svg`](docs/layout-light.svg)。

```
                     命令行 / Node 调用
                              │
        ┌─────────────────────▼─────────────────────┐
        │  ① CLI 层   bin/cardsheet.js               │
        │     parseArgs → 读图 → 写盘 → 打印摘要      │
        └─────────────────────┬─────────────────────┘
                              │ images: [{ buffer, name }]
        ┌─────────────────────▼─────────────────────┐
        │  ② 引擎层   src/sheet.js · buildSheets()   │
        │     规格→毫米→像素 · 版面求解 · 分页         │
        │     contain 缩放 · 逐格 composite · 裁切线   │
        └─────────────────────┬─────────────────────┘
                              │
        ┌─────────────────────▼─────────────────────┐
        │  ③ 图像层   sharp (libvips)                │
        │     metadata · resize · create · composite  │
        └─────────────────────┬─────────────────────┘
                              │
                        pages: Buffer[]
```

CLI 层不认识毫米，引擎层不认识文件系统 —— `buildSheets` 进出都是 `Buffer`，中间不碰磁盘，因此能直接嵌进 Web 服务、Electron 或别的 CLI 而不必改一行。

坐标与单位约定、版面求解规则、渲染管线细节见 **[docs/architecture.md](docs/architecture.md)**。

## 安装

```bash
npm install          # 依赖 sharp
# 或
npm install -g cardsheet
```

要求 Node.js ≥ 20.9。

## 快速开始

```bash
# 一张饮品卡片铺满 A4，带裁切线（300dpi 打印级）
cardsheet card.png --paper a4 --repeat --cutlines

# 3 张样片按顺序排进 4×6 相纸（横放）
cardsheet p1.png p2.png p3.png --paper 4x6 --landscape --gap 3

# A4 摆 2×5 张 86×54mm 名片
cardsheet front.png --cell 86x54 --paper a4 --cols 2 --rows 5 --cutlines
```

不用装也能跑：`npx cardsheet card.png --paper a4 --repeat --cutlines`

## 用法

```
cardsheet <图片...> [选项]
```

| 选项 | 说明 |
| --- | --- |
| `--paper a4` | 纸张预设：`a4 / a5 / a3 / b5 / 4x6 / 5x7 / card`（名片 86×54mm） |
| `--sheet 210x297` | 直接指定纸张尺寸（毫米），优先于 `--paper` |
| `--landscape` | 纸张横放 |
| `--dpi 300` | 输出分辨率（默认 300，打印级；有效范围 36–1200） |
| `--cols 2` | 每行个数（正整数） |
| `--rows 5` | 每列（每页）行数（正整数） |
| `--cell 86x54` | 固定单元格尺寸（毫米），行列数按纸张反推 |
| `--gap 2` | 单元格间距（毫米，默认 2） |
| `--margin 5` | 页边距（毫米，默认 5） |
| `--repeat` | 用第一张图铺满整页（同一张卡片拼版） |
| `--cutlines` | 在间距正中画浅灰裁切线 |
| `--format png` | 输出格式 `png` / `jpeg`（默认 png） |
| `--quality 90` | jpeg 质量 |
| `--prefix sheet` | 输出文件名前缀（多页自动 `-2`、`-3`…） |
| `-o 目录` | 输出目录（默认当前目录，不存在会创建） |

横图 / 竖图自动 `contain` 居中进单元格，多出的部分填成页面底色。参数写错就直接报错（`--cols abc`、裸写 `--cols` 都会报），不会静默换一套版面；给 `--margin`、纸张或 `--cell` 时尺寸会算错也直接报错，不会输出一张全白的纸。

### 版面求解

`--cols / --rows / --cell` 三者的给法决定求解顺序，按下面的优先级短路：

| 给法 | 行为 | 适用 |
| --- | --- | --- |
| `--cell 86x54` | 单元格固定，行列按可用版面反推 | 尺寸优先：裁出来必须和设计稿一比一 |
| `--cols 2 --rows 5` | 行列固定，单元格平分版心 | 版面优先：图之间的差异由 contain 留白吸收 |
| 只给 `--cols` 或 `--rows` | 另一边按首图宽高比推 | 「每行 3 张，行数你定」 |
| 都不给 | 枚举列数，取每页张数最多的方案（并列取列少者） | 只想「一页多塞几张」 |

全自动模式限制单元格最窄 15mm —— 否则一张横图会被排成 1×20 这样的畸形版。

### 关于双面打印

`--repeat` 只使用**第一张**图铺满整页，命令行里传的其余图片会被忽略。正反面各一页要跑两次：

```bash
cardsheet front.png --cell 86x54 --paper a4 --cols 2 --rows 5 --cutlines --prefix front
cardsheet back.png  --cell 86x54 --paper a4 --cols 2 --rows 5 --cutlines --prefix back
# 双面打印时选中「翻转」/「长边翻转」
```

## 命令行 API

```js
const { buildSheets, resolvePaper, PAPERS, mm2px } = require('cardsheet/src/sheet');

const r = await buildSheets({
  images: [{ buffer, name }],   // 必填，顺序即排布顺序
  paper: 'a4',                  // 预设名 或 '宽x高'（毫米）
  dpi: 300,
  landscape: false,
  cols: null, rows: null, cell: null,
  gap: 2, margin: 5,            // 毫米
  repeat: false, cutlines: false,
  background: '#ffffff',
  format: 'png', quality: 90,
});
```

返回：

```js
{ pages,          // Buffer[]，pages[0] 是第 1 页
  pageW, pageH,   // 画布像素
  cols, rows,     // 网格
  cellW, cellH,   // 单元格像素
  perPage, pageCount,
  dpi }
```

`cellW / cellH` 是像素；反算毫米用 `cellW / dpi * 25.4`（CLI 摘要那行就是这么算的）。
另外还导出 `resolvePaper` / `PAPERS` / `mm2px`，方便自己拼版面。

## 项目结构

```
bin/cardsheet.js       CLI 入口：参数解析 → 调引擎 → 写文件 → 打印摘要
src/sheet.js           排版引擎，全部逻辑（~170 行）
test/smoke.js          冒烟测试：引擎直调 5 组 + CLI 全链路 1 组，逐像素断言
scripts/build-diagrams.mjs   由 docs/architecture.md 生成 docs/*.svg
docs/architecture.md   架构文档与 Mermaid 图源码
```

## 测试

```bash
npm test
```

测试不比对图片快照，而是**读像素断言**：裁切线落在间距正中、该处颜色是浅灰 `#c8ccd2`；contain 居中后格子角落是留白、中心是内容；多图超量按 `perPage` 分页。
这样几何改错了会立刻失败，而不会因为编码器版本差异产生假阳性。

## 贡献

架构与几何规则见 [docs/architecture.md](docs/architecture.md)。
改了架构图请编辑 `docs/architecture.md` 里的 Mermaid 代码块，然后：

```bash
npm run docs
```

`docs/*.svg` 是产物，不要直接编辑。
mermaid-cli 会顺带装一份 chromium，其实用不上 —— 脚本会复用本机已装的 Chrome / Edge；不需要那份下载的话装依赖时加 `PUPPETEER_SKIP_DOWNLOAD=1`。

## 📄 许可证

[MIT](LICENSE)
