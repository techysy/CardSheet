# 变更日志

本文件为 cardsheet 完整开发与版本变更日志，按版本从上往下排列。

---

## [Unreleased]

## [0.2.0] (2026-10-04)

朝向、填充方式与输出格式的第二轮。

### ✨ 新功能

- **旋转** `--rotate 0/90/180/270`：每张图先顺时针转再进格子。关键是**版面按转完之后的朝向重算** —— `aspectOf()` 在 90/270 时把宽高互换，否则一张横图转成竖的之后会被塞进一排细高格子里。测试断言的正是「横图转 90° 的版面 == 直接喂竖图的版面」
- **三种填充方式** `--fit`：`contain` 完整放进格子（留白填页面底色，默认）/ `cover` 铺满并裁掉溢出 / `fill` 拉伸变形铺满
- **对齐方位** `--position`：`contain` / `cover` 时的贴边方向（`top`、`left bottom`、`entropy` 等 sharp 支持的方位）
- **PDF 输出** `--format pdf`：把所有页装进**一个**文件，页面尺寸即纸张实尺（px × 72/dpi = PDF 点）。页面按原样嵌入 —— PNG 走 FlateDecode、JPEG 走 DCTDecode，**不重新编码**，所以没有二次画质损失
- **虚线裁切线** `--cutlines dashed`：3mm 实 + 2mm 空，默认比实线浅（`#e2e5ea` vs `#c8ccd2`）。虚线仍用一串 `<rect>` 拼而不是 `stroke-dasharray` —— 后者在 1px 线宽上照样被抗锯齿稀释，打印几乎看不见。裸写 `--cutlines` 行为不变（实线）
- **裁切线颜色可调** `--cutline-color '#d0d4da'`：接受 `#rgb` / `#rrggbb` / `#rrggbbaa`
- **主入口** `src/index.js`：把 `sheet` 与 `pdf` 两个模块再导出一次，`pagesToPdf` 可以直接从 `@techysy/cardsheet` 取，不必写内部路径

### 🛡️ 健壮性

- `rotate` / `fit` / `position` / `format` 走白名单校验：`--rotate 45`、`--fit squish`、`--format gif` 一律报错并列出合法值。此前 `--format` 写错会静默退回 png —— 拼完整版才发现拿到的是 png，是很难查的一类错
- `--cutline-color` 先过一道颜色格式正则：颜色写错时 SVG 的 `fill` 不报错，只会静默渲成黑色，比直接报错更坑
- PDF 页面类型按**魔数**判定（`embedPng` / `embedJpg`）而不是看文件后缀，并逐页包一层错误信息指明是第几页出的问题

### 🔧 CI / 工程化

- **发版前审查** `scripts/release-check.sh`（约定同 CreditDaddy：本地 `npm run release-check` 与 CI 跑同一份脚本）：8 项检查 —— 版本号、JS 语法、单元测试、CHANGELOG 归档与 `[Unreleased]` 残留、tag 与 npm 版本占用（`name@version` 永久不可重用，发布前必须确认没人占）、npm 包清单核对（`files` 白名单之外不得混入）、工作区干净。CI 侧 `release-check.yml` 在手动触发或带 `release` 标签的 PR 上运行
- **release.yml 打包链路拆成三段**：`pack`（测试 → 校验 tag 与版本一致 → `npm pack`）→ `verify`（**Ubuntu / Windows / macOS 三平台**把 tgz 装进干净环境，`bin` 入口可执行 + 真实拼版并校验输出尺寸 472×315 —— sharp 的平台二进制由 registry 按当前平台自动解析，这一步验的就是它）→ `release`（三平台全绿才创建 GitHub Release）
- **ci.yml 对齐 imgmark 约定**：新增生产依赖安全公告硬门禁（`npm audit --omit=dev`，显式官方 registry 避免镜像滞后误报）
- **修 release.yml 试装步骤**：`npm install dist/xxx.tgz` 会被 npm 当成 GitHub 简写（`<user>/<repo>` 形式）转成 `ssh://git@github.com/dist/...`，本机报 `EALLOWGIT`、CI 上则静默走 git 路线死在 `publickey` 上 —— 改用 `file:` 前缀。三平台试装这关是 v0.1.0 发布**之后**才加的，v0.2.0 是它第一次真跑，当场三平台全挂
- **verify 补一步真跑 `--format pdf`**：PDF 是本版新增的输出路径，依赖 pdf-lib。旧步骤只跑不含 PDF 的拼版，pdf-lib 就算漏在 `dependencies` 里也照样全绿，只有 PDF 那条路会在运行时炸

### 📚 文档

- 架构文档新增第 ④ 层「PDF 封装」与对应的流程图节点，说明为什么 PDF 单独成层（排版是「像素怎么摆」，封装是「像素怎么装进文件」，混在一起会让 `buildSheets` 的返回契约变模糊）
- 冒烟测试扩到 13 组：引擎直调 11 组（新增旋转版面等价、非法参数报错、cover/position 像素断言、PDF 往返核对、虚线节奏与深浅、非法裁切线参数）+ CLI 全链路 2 组（新增 PDF 单文件输出）

---

## [0.1.0] (2026-10-03)

首个可发布版本。

### ✨ 新功能

- **拼版引擎** `buildSheets()`：把若干图片按纸张预设 + dpi 换算成像素版面，逐格 contain 居中摆进单元格，超出一页自动分页。返回 `{ pages, pageW, pageH, cols, rows, cellW, cellH, perPage, pageCount, dpi }`
- **纸张预设** `--paper`：`a4 / a5 / a3 / b5 / 4x6 / 5x7 / card`（名片 86×54mm）；`--sheet 210x297` 可直接给毫米尺寸并优先于 `--paper`，`--landscape` 横放
- **四种排布给法**，按 `--cell` → `--cols --rows` → 二选一 → 都不给 的优先级短路：
  - `--cell 86x54`：单元格固定，行列按可用版面反推
  - `--cols 2 --rows 5`：行列固定，单元格平分版心
  - 只给 `--cols` 或 `--rows`：另一边按首图宽高比推
  - 都不给：以首图宽高比枚举列数（单元格最窄 15mm），取「每页张数最多」的方案，并列时取列少者
- **间距与页边距按毫米计**：`--gap`（默认 2mm）、`--margin`（默认 5mm），内部只在入口过一次 `mm2px()`，引擎全程用像素避免舍入累积
- **`--repeat`**：用第一张图铺满整页且不分页 —— 同一张卡片设计批量打印拆件的典型场景
- **`--cutlines`**：在间距正中画浅灰裁切线。线宽按 `dpi / 150`（约 0.17mm）取整像素后画成 SVG 实心 `<rect>`，而不是 stroke 一条 1px 线 —— 后者会被抗锯齿稀释成半透明，打印几乎看不见
- **多图分页**：非 `repeat` 模式下超出 `perPage` 自动分页，输出 `sheet.png` / `sheet-2.png` / `sheet-3.png`…，`--prefix` 可改前缀
- **输出格式**：`--format png / jpeg` + `--quality`，`-o` 指定输出目录（自动创建）

### 🛡️ 健壮性

- dpi 夹在 `[36, 1200]`：`--dpi 0` 不会除出 `Infinity`，也不会因为手滑把内存打爆
- `--cols` / `--rows` 必须是显式给出的正整数：`--cols abc`、裸写 `--cols`、`--cols 0`、`--cols 2.5` 一律报错。此前走 `parseInt` 会得到 `NaN`，而 `NaN` 是 falsy 会一路落到全自动排布 —— 参数写错却静默换了一套版面
- `--margin` 过大导致可用版面不足 20px、单元格边长不足 8px 时直接抛错，而不是输出一张全白的纸
- `--paper` 收到无法识别的值时，报错信息列出全部可用预设与 `宽x高` 格式
- `--prefix` 过滤 Windows 非法文件名字符（`\ / : * ? " < > |`），避免写入时才失败
- 每页独立合成，页与页不共享中间结果 —— 100 页和 1 页的内存占用是同一量级

### 📚 文档

- 架构文档 `docs/architecture.md`（含 Mermaid 图，GitHub 直接渲染）+ 亮 / 暗两套 `docs/*.svg` 产物
- 冒烟测试 `test/smoke.js`：引擎直调 5 组（repeat 铺页 / 顺序分页 / 自动排布 / contain 居中 / 裁切线位置与颜色）逐像素断言 + CLI 全链路 1 组
