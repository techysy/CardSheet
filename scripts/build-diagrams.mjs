#!/usr/bin/env node
/**
 * 由 docs/architecture.md 里的 Mermaid 源码生成 docs/*.svg（亮 / 暗两套配色）。
 *
 *   node scripts/build-diagrams.mjs
 *
 * mermaid-cli 依赖 chromium，太重，不进 package.json 的 devDependencies；
 * 这里用 npx 现取，并优先复用本机已装的 Chrome / Edge，避免每次都重新下载。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'architecture.md');
const DOCS = path.join(ROOT, 'docs');

/** mmdc 在 markdown 模式下按代码块顺序输出 <basename>-1.svg、-2.svg…；这里对应到最终文件名 */
const OUTPUTS = ['architecture', 'layout'];

/** 本机已装的 chromium：找到就复用，省掉 puppeteer 的一次 ~150MB 下载 */
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

/** Windows 上 npm 的可执行文件是 .cmd，直接 spawn 'npx' 会 ENOENT */
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function main() {
  if (!existsSync(SRC)) throw new Error(`找不到 ${path.relative(ROOT, SRC)}`);
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  const cfgDir = mkdtempSync(path.join(tmpdir(), 'cardsheet-mermaid-'));
  const cfg = path.join(cfgDir, 'puppeteer.json');
  writeFileSync(cfg, JSON.stringify({
    ...(found ? { executablePath: found } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  }, null, 2));
  console.log(found ? `复用本机 chromium：${found}` : '未找到本机 chromium，交由 puppeteer 自行下载');

  try {
    for (const theme of ['dark', 'default']) {
      const out = path.join(cfgDir, theme);
      execFileSync(NPX, [
        '-y', '@mermaid-js/mermaid-cli@11',
        '-i', SRC, '-a', out, '-e', 'svg',
        '-t', theme, '-b', 'transparent', '-q',
        '-p', cfg,
      ], { stdio: 'inherit', cwd: ROOT });

      for (const [i, name] of OUTPUTS.entries()) {
        const files = readdirSync(out).filter((f) => f.endsWith('.svg'));
        const src = files.find((f) => f.endsWith(`-${i + 1}.svg`));
        if (!src) throw new Error(`未生成第 ${i + 1} 张图（${files.join('、') || '无输出'}），请检查 docs/architecture.md 的 Mermaid 语法`);
        const dst = path.join(DOCS, `${name}${theme === 'default' ? '-light' : ''}.svg`);
        renameSync(path.join(out, src), dst);
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
