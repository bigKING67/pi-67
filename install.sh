#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────
# pi-67 install.sh — 一键安装 pi 配置
# 通过符号链接将仓库文件映射到 ~/.pi/agent/
# ──────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"
PI_NPM_DIR="$PI_AGENT_DIR/npm"
BACKUP_DIR="$PI_AGENT_DIR/backup-$(date +%Y%m%d-%H%M%S)"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       pi-67 配置安装脚本                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "仓库路径: ${GREEN}$REPO_ROOT${NC}"
echo -e "目标路径: ${GREEN}$PI_AGENT_DIR${NC}"
echo ""

# ─── 检查前置条件 ────────────────────────────────

if ! command -v pi &>/dev/null; then
  echo -e "${RED}错误: 未找到 pi 命令。请先安装: npm install -g @earendil-works/pi-coding-agent${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} pi 已安装: $(pi --version 2>/dev/null || echo 'unknown')"

# ─── 确保 ~/.pi/agent/ 存在 ───────────────────────

if [ ! -d "$PI_AGENT_DIR" ]; then
  echo -e "${YELLOW}~/.pi/agent/ 不存在，正在创建...${NC}"
  mkdir -p "$PI_AGENT_DIR"
  # 运行一次 pi 让它初始化目录
  pi --version >/dev/null 2>&1 || true
fi

# ─── 询问是否备份已有配置 ──────────────────────────

if [ -f "$PI_AGENT_DIR/settings.json" ]; then
  echo ""
  echo -e "${YELLOW}检测到已有 ~/.pi/agent/settings.json${NC}"
  read -r -p "是否备份当前配置到 $BACKUP_DIR？[Y/n] " answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    mkdir -p "$BACKUP_DIR"
    echo -e "${GREEN}备份到 $BACKUP_DIR${NC}"

    # 备份会被覆盖的文件
    for f in settings.json models.json mcp.json auth.json image-gen.json AGENTS.md; do
      if [ -f "$PI_AGENT_DIR/$f" ]; then
        cp "$PI_AGENT_DIR/$f" "$BACKUP_DIR/$f"
        echo "  已备份: $f"
      fi
    done

    # 备份目录
    for d in skills extensions docs prompts scripts templates themes; do
      if [ -d "$PI_AGENT_DIR/$d" ]; then
        cp -r "$PI_AGENT_DIR/$d" "$BACKUP_DIR/$d" 2>/dev/null || true
        echo "  已备份: $d/"
      fi
    done
  else
    echo -e "${YELLOW}跳过备份${NC}"
  fi
fi

# ─── 询问 xtalpi 配置 ─────────────────────────────

echo ""
read -r -p "你是否使用 xtalpi 公司内部 API？[y/N] " xtalpi_answer
xtalpi_answer="${xtalpi_answer:-N}"
if [[ "$xtalpi_answer" =~ ^[Yy]$ ]]; then
  XTALPI_ENABLED=true
  echo -e "${GREEN}✓ 将包含 xtalpi 配置${NC}"
else
  XTALPI_ENABLED=false
  echo -e "${YELLOW}将跳过 xtalpi 相关配置${NC}"
fi

# ─── 创建符号链接 ─────────────────────────────────

echo ""
echo -e "${CYAN}--- 创建符号链接 ---${NC}"

link() {
  local src="$REPO_ROOT/$1"
  local dest="$PI_AGENT_DIR/$2"

  if [ ! -e "$src" ]; then
    echo -e "  ${RED}✗${NC} 源文件不存在: $src"
    return
  fi

  # 如果目标已存在且不是符号链接，先备份
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    cp "$dest" "$BACKUP_DIR/$2" 2>/dev/null || true
  fi

  rm -f "$dest"
  ln -sf "$src" "$dest"
  echo -e "  ${GREEN}✓${NC} $2 -> $src"
}

# 直接链接的文件
link "settings.json" "settings.json"
link "AGENTS.md" "AGENTS.md"

# 目录链接
link "extensions" "extensions"
link "skills" "skills"
link "docs" "docs"
link "prompts" "prompts"
link "scripts" "scripts"
link "templates" "templates"
link "themes" "themes"

# ─── 处理 .example 文件 ────────────────────────────

echo ""
echo -e "${CYAN}--- 配置文件 ---${NC}"

setup_example() {
  local example="$REPO_ROOT/$1"
  local target="$PI_AGENT_DIR/$2"

  if [ -f "$target" ]; then
    echo -e "  ${GREEN}✓${NC} $2 已存在，跳过"
    return
  fi

  if [ -f "$example" ]; then
    cp "$example" "$target"
    echo -e "  ${YELLOW}⚠${NC} 已创建 $2（从 $1 复制），请编辑填写你的配置"
  fi
}

setup_example "models.example.json" "models.json"
setup_example "mcp.example.json" "mcp.json"
setup_example "auth.example.json" "auth.json"
setup_example "image-gen.example.json" "image-gen.json"

# ─── 安装 npm 扩展包 ──────────────────────────────

echo ""
echo -e "${CYAN}--- 安装 npm 扩展包 ---${NC}"

if [ -f "$REPO_ROOT/package.json" ]; then
  mkdir -p "$PI_NPM_DIR"

  # 复制 package.json 到 npm 目录
  cp "$REPO_ROOT/package.json" "$PI_NPM_DIR/package.json"

  cd "$PI_NPM_DIR"
  npm install --ignore-scripts 2>&1 | tail -5
  echo -e "  ${GREEN}✓${NC} npm 扩展包安装完成"
  cd "$REPO_ROOT"
else
  echo -e "  ${YELLOW}⚠${NC} 未找到 package.json，跳过 npm 安装"
fi

# ─── 刷新 Skills ──────────────────────────────────

echo ""
echo -e "${CYAN}--- 刷新 Skills ---${NC}"

if pi skill list &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Skills 已就绪"
else
  echo -e "  ${YELLOW}⚠${NC} 请手动运行 'pi skill list' 验证 Skills"
fi

# ─── 完成 ─────────────────────────────────────────

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       安装完成！                          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}接下来请手动完成以下步骤：${NC}"
echo ""
echo -e "1. 编辑配置文件，填写你的 API key："
echo -e "   ${CYAN}vi ~/.pi/agent/models.json${NC}      # 替换 YOUR_XTALPI_API_KEY"
echo -e "   ${CYAN}vi ~/.pi/agent/mcp.json${NC}         # 修改本地路径 ($HOME 占位符)"
echo -e "   ${CYAN}vi ~/.pi/agent/auth.json${NC}         # 替换 YOUR_DEEPSEEK_API_KEY"
echo -e "   ${CYAN}vi ~/.pi/agent/image-gen.json${NC}    # 替换 YOUR_LOCAL_CODEX_API_KEY"
echo ""

if [ "$XTALPI_ENABLED" = false ]; then
  echo -e "2. 你跳过了 xtalpi 配置，请手动修改 settings.json："
  echo -e "   ${CYAN}将 defaultProvider 改为非 xtalpi 的 provider${NC}"
  echo -e "   ${CYAN}将 defaultModel 改为对应模型${NC}"
  echo ""
fi

echo -e "3. 启动 pi 验证："
echo -e "   ${CYAN}pi${NC}"
echo ""

if [ -d "$BACKUP_DIR" ]; then
  echo -e "备份文件保存在: ${CYAN}$BACKUP_DIR${NC}"
fi

echo -e "更新配置只需: ${CYAN}cd $REPO_ROOT && git pull${NC}"
echo ""