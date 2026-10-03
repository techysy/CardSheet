# 架构说明

cardsheet 只有一个运行时依赖（[sharp](https://sharp.pixelplumbing.com/)），全部功能压在一个约 170 行的排版引擎里，没有插件系统、没有中间层服务。
所以这里的「架构」重点不是模块划分，而是**三件事**：坐标与单位的约定、版面是怎么算出来的、以及每一步的输入输出。

> 本文件是架构图的**源**。图由 [Mermaid](https://mermaid.js.org/) 生成，GitHub 上直接渲染；离线查看或需要矢量图时按文末的 [导出 SVG](#导出-svg) 生成 `docs/architecture.svg`。

## 总览

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 460}, "themeVariables": {"fontSize": "15px"}}}%%
flowchart TB
    classDef cli   fill:#1f6feb22,stroke:#1f6feb,color:#0b2e63
    classDef eng   fill:#8250df22,stroke:#8250df,color:#3b1a70
    classDef lib   fill:#1a7f3722,stroke:#1a7f37,color:#0d3d1c
    classDef io    fill:#bf870022,stroke:#bf8700,color:#5c3c00

    IN(["图片文件"]):::io

    subgraph L1["① CLI 层 · bin/cardsheet.js"]
        direction TB
        A["<b>parseArgs</b> 参数解析<br/>读图 → { buffer, name }<br/>mkdirSync + writeFileSync<br/>控制台摘要"]:::cli
    end

    subgraph L2["② 引擎层 · src/sheet.js · buildSheets()"]
        direction TB
        B["<b>mm2px</b> 规格 → 毫米 → 像素<br/><b>solveLayout</b> cols × rows × cell<br/><b>paginate</b> repeat 铺满 / 顺序分页<br/><b>render</b> contain 缩放 + 逐格 composite<br/><b>cutlineSvg</b> 间距正中叠一层裁切线<br/><b>encode</b> png / jpeg"]:::eng
    end

    subgraph L3["③ 图像层 · sharp (libvips)"]
        direction TB
        C["<b>metadata</b> 读原图宽高<br/><b>resize</b> fit:contain<br/><b>create</b> 空白画布<br/><b>composite</b> 逐格叠加<br/>png / jpeg 编码"]:::lib
    end

    OUT(["pages: Buffer[]<br/>sheet.png / sheet-2.png"]):::io

    IN --> A
    A -- "images" --> B
    B -- "渲染每页" --> C
    C -- "pages" --> OUT
```

**边界约定**：CLI 层不认识毫米，引擎层不认识文件系统。
`buildSheets` 的输入已经是 `Buffer`、输出是 `Buffer[]`，中间不碰磁盘 —— 这样引擎能直接嵌进别的程序（Web 服务、Electron、另一个 CLI）而不必改一行。
引擎另外还导出 `resolvePaper` / `PAPERS` / `mm2px`，供外部自己拼版面。

## 坐标系与单位

这是全项目唯一容易出错的地方，所以单独拎出来。

| 层 | 单位 | 说明 |
| --- | --- | --- |
| 命令行 | **毫米** | `--cell 86x54`、`--gap 2`、`--margin 5`、`--paper a4` 全是毫米 |
| 引擎内部 | **像素** | 进入 `buildSheets` 第一个动作就是把所有毫米过一遍 `mm2px()` |
| 输出 | **像素 + 毫米** | 返回 `cellW/cellH` 是像素，由 CLI 用 `cellW / dpi * 25.4` 反算毫米打印 |

```js
mm2px = (mm, dpi) => Math.max(1, Math.round(mm / 25.4 * dpi))
```

- 换算**只在入口做一次**，引擎内部不再出现毫米，避免舍入误差在几何里累积。
- dpi 被夹在 `[36, 1200]`：`--dpi 0` 不会除出 `Infinity`，也不会因为手滑把内存打爆。
- 单元格边长夹在 `>= 8px`、可用版面夹在 `>= 20px`，越界直接抛错而不是画出一张全白的纸。

## 版面求解

`cols / rows / cell` 三者的给法决定了求解顺序，这是引擎里唯一带分支的算法。
四条路径按 `--cell` → `--cols --rows` → 二选一 → 都不给 的优先级短路：

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 420}, "themeVariables": {"fontSize": "15px"}}}%%
flowchart TB
    classDef q    fill:#bf870022,stroke:#bf8700,color:#5c3c00
    classDef out  fill:#1a7f3722,stroke:#1a7f37,color:#0d3d1c

    S([开始]):::q
    Q1{给了 --cell ?}:::q
    Q2{给了 --cols 和 --rows ?}:::q
    Q3{只给了其中一个 ?}:::q

    A1["<b>cell 给定</b><br/>行列按纸张反推<br/>floor（版心 + gap）/（cell + gap）"]:::out
    A2["<b>行列给定</b><br/>单元格平分版心<br/>floor（版心 − (n−1)·gap）/ n"]:::out
    A3["<b>只给一个</b><br/>首图宽高比定另一边<br/>另一方向反推能排下几行 / 几列"]:::out
    A4["<b>全自动</b><br/>枚举列数 1..N，以首图宽高比算行数<br/>取每页张数最多，并列取列少者"]:::out

    R([cols · rows · cellW · cellH]):::out

    S --> Q1
    Q1 -->|是| A1
    Q1 -->|否| Q2
    Q2 -->|是| A2
    Q2 -->|否| Q3
    Q3 -->|是| A3
    Q3 -->|否| A4
    A1 --> R
    A2 --> R
    A3 --> R
    A4 --> R
```

**全自动为什么这样选**：用户只给了一堆图和一个纸张，想要的是「一页塞最多」。
枚举列数、每种列数按首图宽高比推出行数，取乘积最大者；单元格最窄限制 15mm，否则一张横图会被排成 1×20 这样的畸形版。
并列时**保留列少的那个**（`c * r > best.count` 是严格大于），因为列少 = 每张占的横向面积更大，裁切后尺寸更接近原图预期。

> **为什么这个循环不做提前退出 / 不从多到少枚举。**
> 试过把枚举反过来（`c` 从 `maxCols` 递减，声称「撞到最优解就退出」），两个问题：
> 一是并没有 `break`，循环照样跑满区间，计算量一分没省；二是方向一反转，「严格大于保留先遇到的」就从「并列取列少」悄悄变成「并列取列多」，和代码里自己的注释、也和上面的文档全部对不上。
>
> 更根本的是提前退出在这里没有收益：`count` 在整个区间内单调递增（列越多 → 单元格越窄 → 每页张数越多），最优解永远在末位 `c = maxCols`。整段枚举只有几十次，省不下什么；而退出条件要敢信，就得先把单调性证明一遍。反过来从少到多枚举，还顺带把「并列取列少」这个语义保住。
>
> 顺带一提：因为 `minCell = 15mm` 把 `maxCols` 摁在够小的范围内，实测 7 种纸张 × 6 档 dpi × 4 档边距 × 5 档间距 × 120 种宽高比共 100800 种组合，**一次并列都没出现**。所以上面那个方向反转是潜在不一致，不是现网 bug —— 但注释必须和代码一致，否则下一个人会照着注释改代码，改出真 bug。

**为什么 `--cols 2 --rows 5` 的单元格是平分而不是按图缩放**：给了行列就意味着用户要的是「固定 2×5 的版面」，图片之间的差异由 contain 的留白吸收。反过来给了 `--cell` 就是「尺寸优先」，行列是结果不是目的。

## 渲染管线

每一页是一次独立的 `sharp` 合成，**页与页之间不共享中间结果** —— 这样 100 页和 1 页的内存占用是同一量级。

```
① 逐图 resize(cellW, cellH, { fit: 'contain', background })
      ↑ 横图进竖格、竖图进横格都靠 contain 自动适配，多余部分填成页面底色
② sharp({ create: { width: pw, height: ph, channels: 3, background } })
      ↑ 先铺一张整页底色，格子外的留白和图片 contain 后的空隙因此是同色
③ composite([...逐格 { input, left, top }])
      left = margin + col * (cellW + gap)
      top  = margin + row * (cellH + gap)
④ 若 --cutlines，末尾再 composite 一张整页 SVG
⑤ .png() / .jpeg({ quality })
```

**裁切线为什么用 SVG `<rect>` 而不是 `<line>`**：线宽按 `dpi / 150` 算（约 0.17mm），再 `Math.round` 成整数像素后画成矩形。
直接 stroke 一条 1px 线会被抗锯齿稀释成半透明，打印出来几乎看不见；画成实心矩形则保证落到纸上是一条实实在在的浅灰线。

**裁切线只画在间距正中**：位置是 `margin + c·(cellW + gap) - gap / 2`。
这意味着 `--gap 0` 时线画在格子边界上（`gap/2 = 0`），此时线条会压在图片上，需要注意。

## 目录结构

```
bin/cardsheet.js    CLI 入口：参数解析 → 调引擎 → 写文件 → 打印摘要
src/sheet.js        排版引擎，全部逻辑；导出 buildSheets / resolvePaper / PAPERS / mm2px
test/smoke.js       冒烟测试：引擎直调 5 组 + CLI 全链路 1 组，逐像素断言
docs/               架构文档与图
```

引擎没有内部状态，`buildSheets` 可以并发调用。CLI 与引擎之间只有 `buildSheets` 一个契约 —— 换前端、换 UI、加 Web 面板都不需要动 `src/sheet.js`。

## 对外 API

```js
const { buildSheets, resolvePaper, PAPERS, mm2px } = require('cardsheet/src/sheet');

const r = await buildSheets({
  images: [{ buffer, name }],   // 必填，顺序即排布顺序
  paper: 'a4',                  // 预设名 或 '宽x高'(毫米)
  dpi: 300,
  landscape: false,
  cols: null, rows: null,       // 与 cell 的优先级见上文决策树
  cell: null,
  gap: 2, margin: 5,            // 毫米
  repeat: false, cutlines: false,
  background: '#ffffff',
  format: 'png', quality: 90,
});

// → { pages: Buffer[], pageW, pageH, cols, rows, cellW, cellH, perPage, pageCount, dpi }
```

`pages` 是 `Buffer[]`，按 `pages[0]`、`pages[1]`… 顺序对应第 1、2 页。返回的 `cellW/cellH` 是像素，除以 `dpi` 再乘 25.4 就是毫米 —— 这也是 CLI 摘要那行的算法。

## 导出 SVG

仓库里已包含 `docs/architecture.svg` / `architecture-light.svg` 与 `docs/layout.svg` / `layout-light.svg`（暗 / 亮两套配色），由本文件的 Mermaid 块生成。
改了图之后重新生成：

```bash
npm run docs
```

**改图只需要改本文件的 Mermaid 代码块**，不要直接编辑 `docs/*.svg` —— 那些是产物，下次生成会被覆盖。
