#!/usr/bin/env bash
# cardsheet 发版前审查脚本（约定同 CreditDaddy：本地与 CI 跑同一份，逻辑只维护这一处）
# 用法：npm run release-check  或  ./scripts/release-check.sh [版本号]
# 示例：./scripts/release-check.sh 0.2.0

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${BLUE}  CardSheet 发版前审查${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo ""

ERRORS=0
WARNINGS=0

# ── 1. 版本号 ──────────────────────────────────────────────
echo -e "${YELLOW}[1/8] 🔢 版本号检查${NC}"
VERSION=$(node -p "require('./package.json').version")
if [ -n "${1:-}" ] && [ "$VERSION" != "$1" ]; then
  echo -e "  ${RED}✗ package.json ($VERSION) ≠ 期望版本 ($1)${NC}"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✓ package.json：$VERSION${NC}"
fi
echo ""

# 提前探测 tag，供检查 4/6 区分「发版」与「已发布版本复查」两种模式
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  ALREADY_RELEASED=1
else
  ALREADY_RELEASED=0
fi

# ── 2. 语法检查 ────────────────────────────────────────────
echo -e "${YELLOW}[2/8] 🗂️ JS 语法检查${NC}"
SYNTAX_FAIL=0
for f in bin/*.js src/*.js test/*.js scripts/*.mjs; do
  [ -f "$f" ] || continue
  if ! node --check "$f" 2>&1; then
    echo -e "  ${RED}✗ $f 语法错误${NC}"
    SYNTAX_FAIL=1
    ERRORS=$((ERRORS + 1))
  fi
done
if [ $SYNTAX_FAIL -eq 0 ]; then
  echo -e "  ${GREEN}✓ 所有 JS 文件语法正确${NC}"
fi
echo ""

# ── 3. 单元测试 ────────────────────────────────────────────
echo -e "${YELLOW}[3/8] 🧪 单元测试${NC}"
TEST_OUT=$(mktemp)
if npm test > "$TEST_OUT" 2>&1; then
  echo -e "  ${GREEN}✓ $(grep -oE '结果：.*' "$TEST_OUT" | tail -1)${NC}"
else
  echo -e "  ${RED}✗ 测试失败${NC}"
  tail -20 "$TEST_OUT"
  ERRORS=$((ERRORS + 1))
fi
rm -f "$TEST_OUT"
echo ""

# ── 4. CHANGELOG ───────────────────────────────────────────
echo -e "${YELLOW}[4/8] 📋 CHANGELOG 包含本版本条目${NC}"
CHANGELOG_HAS_VERSION=0
if grep -qE "^## \[${VERSION}\]" CHANGELOG.md; then
  echo -e "  ${GREEN}✓ CHANGELOG.md 已包含 [${VERSION}] 条目${NC}"
  CHANGELOG_HAS_VERSION=1
else
  echo -e "  ${RED}✗ CHANGELOG.md 中没有找到 [${VERSION}] 版本条目${NC}"
  echo -e "     请把 [Unreleased] 内容归档到 [${VERSION}]（附发版日期）"
  ERRORS=$((ERRORS + 1))
fi
echo ""

echo -e "${YELLOW}[5/8] 📋 [Unreleased] 段落无遗留内容${NC}"
UNRELEASED=$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md | grep -v '^[[:space:]]*$' | grep -v '^---' | grep -v '^###' || true)
if [ -n "$UNRELEASED" ]; then
  if [ "$ALREADY_RELEASED" = "1" ]; then
    echo -e "  ${BLUE}ℹ [Unreleased] 中有下一版本的内容（已发布版本复查属正常）${NC}"
  else
    echo -e "  ${YELLOW}⚠ [Unreleased] 段落仍有内容未归档：${NC}"
    echo "$UNRELEASED" | head -5
    WARNINGS=$((WARNINGS + 1))
  fi
else
  echo -e "  ${GREEN}✓ [Unreleased] 段落为空${NC}"
fi
echo ""

# ── 6. Tag 与 npm 版本占用 ─────────────────────────────────
echo -e "${YELLOW}[6/8] 🏷️ Tag 与 npm 版本占用检查${NC}"
if [ "$ALREADY_RELEASED" = "1" ]; then
  echo -e "  ${BLUE}ℹ tag v${VERSION} 已存在 —— 本次为已发布版本复查${NC}"
else
  echo -e "  ${GREEN}✓ tag v${VERSION} 未被占用${NC}"
fi
# npm 的 name@version 永久不可重用（unpublish 也找不回），发布前必须确认没人占
NPM_TAKEN=$(npm view "@techysy/cardsheet@${VERSION}" version --registry=https://registry.npmjs.org 2>/dev/null || true)
if [ -n "$NPM_TAKEN" ]; then
  if [ "$ALREADY_RELEASED" = "1" ]; then
    echo -e "  ${BLUE}ℹ npm 上已发布 ${VERSION}（与 tag 一致，复查正常）${NC}"
  else
    echo -e "  ${RED}✗ npm 上已存在 @techysy/cardsheet@${VERSION}，但 tag 还没打 —— 版本号冲突，请先 bump${NC}"
    ERRORS=$((ERRORS + 1))
  fi
else
  if [ "$ALREADY_RELEASED" = "1" ]; then
    echo -e "  ${YELLOW}⚠ tag 已存在但 npm 上查不到 ${VERSION}（registry 同步延迟或漏发）${NC}"
    WARNINGS=$((WARNINGS + 1))
  else
    echo -e "  ${GREEN}✓ npm 上版本可用：@techysy/cardsheet@${VERSION}${NC}"
  fi
fi
echo ""

# ── 7. npm 包清单 ──────────────────────────────────────────
echo -e "${YELLOW}[7/8] 📦 npm 包清单核对（files 白名单之外不得混入）${NC}"
if npm pack --dry-run --json 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  // npm 输出按包名 keyed 的对象；文件路径不带 package/ 前缀
  const root = Object.values(JSON.parse(s))[0];
  const paths = root.files.map((f) => f.path);
  const allow = /^(bin\/|src\/|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$)/;
  const bad = paths.filter((p) => !allow.test(p));
  const need = [
    "package.json", "bin/cardsheet.js", "src/sheet.js",
    "README.md", "CHANGELOG.md", "LICENSE",
  ].filter((p) => !paths.includes(p));
  if (bad.length)  { console.log("混入: " + bad.join(", ")); process.exit(1); }
  if (need.length) { console.log("缺失: " + need.join(", ")); process.exit(1); }
  console.log(`包内 ${paths.length} 个文件，清单干净`);
});'; then
  echo -e "  ${GREEN}✓ 包清单干净${NC}"
else
  echo -e "  ${RED}✗ 包清单有问题，请检查 package.json 的 files 字段${NC}"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ── 8. 工作区干净 ──────────────────────────────────────────
echo -e "${YELLOW}[8/8] 🧹 Git 工作区干净${NC}"
if [ -n "$(git status --porcelain)" ]; then
  echo -e "  ${RED}✗ 工作区有未提交改动（npm version 也会因此拒绝执行）${NC}"
  git status --short | head -8
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✓ 工作区干净${NC}"
fi
echo ""

# ── 附：最近提交统计 ──────────────────────────────────────
LAST_TAG=$(git tag -l 'v*' | sort -V | tail -1)
if [ -n "$LAST_TAG" ]; then
  COMMIT_COUNT=$(git rev-list --count HEAD "^${LAST_TAG}" 2>/dev/null || echo "0")
  if [ "$COMMIT_COUNT" -gt 0 ]; then
    echo -e "  ${BLUE}ℹ 自上个版本 ${LAST_TAG} 以来有 ${COMMIT_COUNT} 个提交（最近 5 条）：${NC}"
    git log --oneline -5 || true
    echo ""
  fi
fi

# ── 汇总 ──────────────────────────────────────────────────
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
if [ $ERRORS -eq 0 ]; then
  if [ "$ALREADY_RELEASED" = "1" ]; then
    echo -e "${GREEN}  ✅ v${VERSION} 复查通过（该版本已发布）${NC}"
  else
    echo -e "${GREEN}  ✅ 发版前审查通过${NC}"
  fi
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}     警告：$WARNINGS 处（非阻塞）${NC}"
  fi
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo ""
  if [ "$ALREADY_RELEASED" != "1" ]; then
    echo "下一步："
    echo "  1. 确认 CHANGELOG.md [${VERSION}] 内容准确（[Unreleased] 已归档）"
    echo "  2. （可选）本机试装：npm pack && npm i -g ./techysy-cardsheet-${VERSION}.tgz && cardsheet --help"
    echo "  3. npm run release          # 或单独：npm run publish:npm && git push --follow-tags"
    echo "  4. 等待 release.yml 全绿（三平台试装验证通过后才创建 GitHub Release）"
  fi
  echo ""
  exit 0
else
  echo -e "${RED}  ✗ 发版前审查失败：$ERRORS 个错误${NC}"
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}     警告：$WARNINGS 处${NC}"
  fi
  echo -e "${RED}═══════════════════════════════════════════════${NC}"
  echo ""
  echo "请修复上述错误后重新运行审查"
  echo ""
  exit 1
fi
