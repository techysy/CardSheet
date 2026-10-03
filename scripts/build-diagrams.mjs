#!/usr/bin/env node
/**
 * 由 docs/architecture.md 里的 Mermaid 源码生成 docs/*.svg（亮 / 暗两套配色）。
 *
 *   npm run docs
 *
 * mermaid-cli 会顺带装一份 chromium，其实用不上 —— 下面会优先复用本机已装的
 * Chrome / Edge。不需要那份下载的话：`PUPPETEER_SKIP_DOWNLOAD=1 npm install`。
 *
 * 直接用 `node` 调 mermaid-cli 的入口脚本，不走 shell：Windows 上 npx / npm 是 .cmd，
 * 经 shell 转发时「F:\Files\GitHub Files\...」里的空格和引号会被 cmd.exe 拆坏。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'architecture.md');
const DOCS = path.join(ROOT, 'docs');

/** mmdc 在 markdown 模式下按代码块顺序输出 <basename>-1.svg、-2.svg…；这里对应到最终文件名 */
const OUTPUTS = ['architecture', 'layout'];

/** 本机已装的 chromium：找到就复用，省掉 puppeteer 自带的那份 */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * 定位 mermaid-cli 的命令行入口。
 *
 * 该包的 `exports` 只导出了 "."，所以 `require.resolve('.../src/cli.js')` 会被 exports
 * 挡下来（ERR_PACKAGE_PATH_NOT_EXPORTED）。改成从主入口反推包根目录再拼 src/cli.js。
 */
function resolveCli() {
  let entry;
  try {
    entry = require.resolve('@mermaid-js/mermaid-cli');
  } catch {
    throw new Error('未安装 @mermaid-js/mermaid-cli，先跑 `npm install`');
  }
  for (let dir = path.dirname(entry), i = 0; i < 4; i++, dir = path.dirname(dir)) {
    const cli = path.join(dir, 'src', 'cli.js');
    if (existsSync(cli)) return cli;
  }
  throw new Error('在 @mermaid-js/mermaid-cli 里找不到 src/cli.js，版本可能不兼容');
}

function main() {
  if (!existsSync(SRC)) throw new Error(`找不到 ${path.relative(ROOT, SRC)}`);
  const mmdc = resolveCli();

  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  const cfgDir = mkdtempSync(path.join(tmpdir(), 'cardsheet-mermaid-'));
  const cfg = path.join(cfgDir, 'puppeteer.json');
  writeFileSync(cfg, JSON.stringify({
    ...(found ? { executablePath: found } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  }, null, 2));
  console.log(found ? `复用本机 chromium：${found}` : '未找到本机 chromium，用 puppeteer 自带的那份');

  try {
    for (const theme of ['dark', 'default']) {
      const out = path.join(cfgDir, theme);
      execFileSync(process.execPath, [
        mmdc,
        '-i', SRC, '-a', out, '-e', 'svg',
        '-t', theme, '-b', 'transparent', '-q',
        '-p', cfg,
      ], { stdio: 'inherit', cwd: ROOT });

      for (const [i, name] of OUTPUTS.entries()) {
        const files = readdirSync(out).filter((f) => f.endsWith('.svg'));
        const src = files.find((f) => f.endsWith(`-${i + 1}.svg`));
        if (!src) {
          throw new Error(`未生成第 ${i + 1} 张图（现有：${files.join('、') || '无'}），请检查 docs/architecture.md 的 Mermaid 语法`);
        }
        const dst = path.join(DOCS, `${name}${theme === 'default' ? '-light' : ''}.svg`);
        // 临时目录与项目可能不在同一个盘（F: 上的仓库 + C: 上的 TEMP），rename 会 EXDEV
        const from = path.join(out, src);
        copyFileSync(from, dst);
        rmSync(from, { force: true });
        console.log(`  ${path.relative(ROOT, dst)}`);
      }
    }
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
  console.log('✓ 架构图已更新');
}

try {
  main();
} catch (e) {
  console.error('✗', e.message);
  process.exit(1);
}
