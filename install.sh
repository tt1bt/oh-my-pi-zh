#!/usr/bin/env sh
# oh-my-pi-zh — 一行安装（macOS / Linux）
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/tt1bt/oh-my-pi-zh/main/install.sh | sh
#
# 做了什么:
#   1. 检查 bun
#   2. 把本仓库下载到固定目录（默认 ~/.oh-my-pi-zh，无需 git）
#   3. 若未安装上游 omp，自动 bun add -g @oh-my-pi/pi-coding-agent@latest
#   4. 运行 scripts/apply.ts 应用汉化并安装 omp 启动器
#
# 可用参数 / 环境变量（可选）:
#   --dir <path>       安装目录（默认 ~/.oh-my-pi-zh；等价 OMP_ZH_DIR）
#   --ref <ref>        分支/标签（默认 main；等价 OMP_ZH_REF）
#   --no-apply         只下载不应用汉化（调试用；等价 OMP_ZH_SKIP_APPLY=1）
#
# 管道执行时传参: curl ... | sh -s -- --dir ~/oh-my-pi-zh

set -eu

say() { printf '[omp-zh] %s\n' "$1"; }
die() { printf '[omp-zh] %s\n' "$1" >&2; exit 1; }

usage() {
	cat <<'EOF'
oh-my-pi-zh 安装脚本

用法:
  curl -fsSL https://raw.githubusercontent.com/tt1bt/oh-my-pi-zh/main/install.sh | sh
  sh install.sh [--dir <path>] [--ref <ref>] [--no-apply]

选项:
  --dir <path>   安装目录（默认 ~/.oh-my-pi-zh）
  --ref <ref>    分支/标签（默认 main）
  --no-apply     只下载不应用汉化（调试用）
  -h, --help     显示本帮助
EOF
}

# ---------- 0. 参数 ----------
DIR_ARG=""
REF_ARG=""
NO_APPLY=0
while [ $# -gt 0 ]; do
	case "$1" in
	--dir)
		[ $# -ge 2 ] || die "--dir 需要一个路径"
		DIR_ARG="$2"
		shift 2
		;;
	--ref)
		[ $# -ge 2 ] || die "--ref 需要一个值"
		REF_ARG="$2"
		shift 2
		;;
	--no-apply)
		NO_APPLY=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "未知参数: $1（用 --help 查看用法）"
		;;
	esac
done

# ---------- 1. bun ----------
if ! command -v bun >/dev/null 2>&1; then
	printf '\n'
	printf '[omp-zh] 未检测到 bun。请先安装后再重跑本命令：\n'
	printf '  curl -fsSL https://bun.sh/install | bash\n'
	printf '  安装后请重开一个终端（让 PATH 生效）。\n\n'
	exit 1
fi
say "bun $(bun --version)"

# ---------- 2. 下载仓库 ----------
REF="${REF_ARG:-${OMP_ZH_REF:-main}}"
DIR="${DIR_ARG:-${OMP_ZH_DIR:-$HOME/.oh-my-pi-zh}}"
URL="https://github.com/tt1bt/oh-my-pi-zh/archive/refs/heads/${REF}.tar.gz"

say "下载 $URL ..."
# 临时目录：优先系统临时目录，不可写时退回安装目录旁边（容器/受限环境常见）
TMP=""
for cand in "${TMPDIR:-/tmp}" "$(dirname "$DIR")"; do
	mkdir -p "$cand" 2>/dev/null || continue
	[ -w "$cand" ] || continue
	TMP="$(mktemp -d "$cand/omp-zh.XXXXXX" 2>/dev/null || true)"
	[ -n "$TMP" ] && break
done
[ -n "$TMP" ] || die "找不到可写的临时目录，请设置 TMPDIR 后重试。"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
	curl -fsSL "$URL" -o "$TMP/src.tar.gz" || die "下载失败，请检查网络后重试。"
elif command -v wget >/dev/null 2>&1; then
	wget -q "$URL" -O "$TMP/src.tar.gz" || die "下载失败，请检查网络后重试。"
else
	die "未找到 curl 或 wget，无法下载。"
fi

tar -xzf "$TMP/src.tar.gz" -C "$TMP" || die "解压失败。"
INNER="$(find "$TMP" -maxdepth 1 -type d -name 'oh-my-pi-zh-*' | head -n 1)"
[ -n "$INNER" ] || die "解压结果异常，未找到仓库目录。"

# 覆盖安装：仅当目标目录确实是本项目的旧副本时才删除，避免误删用户其他目录
if [ -e "$DIR" ]; then
	OK=0
	if [ -f "$DIR/package.json" ]; then
		if grep -q '"name"[[:space:]]*:[[:space:]]*"oh-my-pi-zh"' "$DIR/package.json" 2>/dev/null; then OK=1; fi
	fi
	if [ "$OK" -ne 1 ]; then
		printf '[omp-zh] 目标目录已存在且不是本项目副本，已中止以免误删:\n  %s\n' "$DIR" >&2
		printf '[omp-zh] 请改用其他目录（设置环境变量 OMP_ZH_DIR）后重试。\n' >&2
		exit 1
	fi
	rm -rf "$DIR"
fi
mkdir -p "$(dirname "$DIR")"
mv "$INNER" "$DIR"
say "已就位: $DIR"

if [ "$NO_APPLY" -eq 1 ] || [ "${OMP_ZH_SKIP_APPLY:-}" = "1" ]; then say "已跳过应用步骤（--no-apply）。"; exit 0; fi

# ---------- 3. 确保上游 omp 已安装 ----------
OMP_PKG="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/@oh-my-pi/pi-coding-agent"
if [ ! -d "$OMP_PKG" ]; then
	say "未检测到上游 omp，正在安装 @oh-my-pi/pi-coding-agent@latest ..."
	bun add -g "@oh-my-pi/pi-coding-agent@latest" || die "安装上游 omp 失败，请手动执行: bun add -g @oh-my-pi/pi-coding-agent"
fi

# ---------- 4. 应用汉化 ----------
say "应用汉化 ..."
if bun "$DIR/scripts/apply.ts"; then
	printf '\n'
	printf '[omp-zh] 完成！\n'
	printf '  直接运行 omp 即为中文界面。\n'
	printf '  以后 omp 升级后首次启动会自动重打汉化；也可随时重跑本命令更新。\n'
	printf '  卸载: 删除 ~/.local/bin/omp 与 %s 目录即可。\n' "$DIR"
else
	printf '\n[omp-zh] 汉化应用失败。可手动重试: bun "%s/scripts/apply.ts"\n' "$DIR" >&2
	exit 1
fi
