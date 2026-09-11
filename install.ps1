# oh-my-pi-zh — 一行安装（Windows / PowerShell）
#
# 用法:
#   irm https://raw.githubusercontent.com/tt1bt/oh-my-pi-zh/main/install.ps1 | iex
#
# 做了什么:
#   1. 检查 bun
#   2. 把本仓库下载到固定目录（默认 %USERPROFILE%\.oh-my-pi-zh，无需 git）
#   3. 若未安装上游 omp，自动 bun add -g @oh-my-pi/pi-coding-agent@latest
#   4. 运行 scripts/apply.ts 应用汉化并安装 omp 启动器
#
# 可用环境变量（可选）:
#   OMP_ZH_DIR         安装目录（默认 %USERPROFILE%\.oh-my-pi-zh）
#   OMP_ZH_REF         分支/标签（默认 main）
#   OMP_ZH_SKIP_APPLY  设为 1 时只下载不应用（调试用）
#
# 注意: 本脚本被 `irm | iex` 调用，处于当前会话作用域，因此一律用 return 而非 exit。

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
# 关闭 Invoke-WebRequest / Expand-Archive 的进度条（否则 irm|iex 输出会被刷屏）
$ProgressPreference = "SilentlyContinue"

function Say($msg) { Write-Host "[omp-zh] $msg" }

function Show-Usage {
	# 刻意不用 here-string：本仓库 .ps1 为 LF 换行，Windows PowerShell 5.1 下 here-string 会解析失败
	Write-Host "oh-my-pi-zh 安装脚本"
	Write-Host ""
	Write-Host "用法:"
	Write-Host "  irm https://raw.githubusercontent.com/tt1bt/oh-my-pi-zh/main/install.ps1 | iex"
	Write-Host "  .\install.ps1 [-Dir <path>] [-Ref <ref>] [-NoApply]"
	Write-Host ""
	Write-Host "选项:"
	Write-Host "  -Dir <path>   安装目录（默认 %USERPROFILE%\.oh-my-pi-zh）"
	Write-Host "  -Ref <ref>    分支/标签（默认 main）"
	Write-Host "  -NoApply      只下载不应用汉化（调试用）"
	Write-Host "  -Help         显示本帮助"
}

# ---------- 参数（$args 手动解析：irm|iex 场景下 $args 为空，走环境变量/默认值） ----------
$ArgDir = ""
$ArgRef = ""
$ArgNoApply = $false
for ($i = 0; $i -lt $args.Count; $i++) {
	switch -Regex ($args[$i]) {
		'^-(Dir|dir)$' { $ArgDir = if ($i + 1 -lt $args.Count) { $args[++$i] } else { "" } }
		'^-(Ref|ref)$' { $ArgRef = if ($i + 1 -lt $args.Count) { $args[++$i] } else { "" } }
		'^-(NoApply|no-apply)$' { $ArgNoApply = $true }
		'^-(Help|h|\?)$' { Show-Usage; return }
		default {
			Write-Host "[omp-zh] 未知参数: $($args[$i])（用 -Help 查看用法）" -ForegroundColor Red
			return
		}
	}
}

# ---------- 1. bun ----------
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
	Write-Host ""
	Write-Host "[omp-zh] 未检测到 bun。请先安装后再重跑本命令：" -ForegroundColor Yellow
	Write-Host '  powershell -c "irm bun.sh/install.ps1 | iex"' -ForegroundColor Yellow
	Write-Host "  安装后请重开一个终端（让 PATH 生效）。"
	Write-Host ""
	return
}
Say ("bun " + (& bun --version))

# 尽力删除（失败不影响主流程；某些受限环境的 Remove-Item 会被拦截）
function Try-Remove($path) {
	if (-not $path -or -not (Test-Path $path)) { return $true }
	try { Remove-Item -Recurse -Force $path -ErrorAction Stop; return $true } catch { return $false }
}

# ---------- 2. 下载仓库 ----------
$ref = if ($ArgRef) { $ArgRef } elseif ($env:OMP_ZH_REF) { $env:OMP_ZH_REF } else { "main" }
$dir = if ($ArgDir) { $ArgDir } elseif ($env:OMP_ZH_DIR) { $env:OMP_ZH_DIR } else { Join-Path $env:USERPROFILE ".oh-my-pi-zh" }
$dir = [System.IO.Path]::GetFullPath($dir)
$url = "https://github.com/tt1bt/oh-my-pi-zh/archive/refs/heads/$ref.zip"

Say "下载 $url ..."
$tmp = Join-Path $env:TEMP ("omp-zh-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
	$zip = Join-Path $tmp "src.zip"
	Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
	Expand-Archive -Path $zip -DestinationPath $tmp -Force
} catch {
	Write-Host "[omp-zh] 下载或解压失败: $_" -ForegroundColor Red
	[void](Try-Remove $tmp)
	return
}

$inner = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "oh-my-pi-zh-*" } | Select-Object -First 1
if (-not $inner) {
	Write-Host "[omp-zh] 解压结果异常，未找到仓库目录。" -ForegroundColor Red
	[void](Try-Remove $tmp)
	return
}

# 覆盖安装：先核对目标目录确实是本项目的旧副本（避免误删用户其他目录），
# 再"改名挪走"而不是直接删除——这样即使旧目录被占用/删除受限也能完成替换。
$old = ""
if (Test-Path $dir) {
	$marker = Join-Path $dir "package.json"
	$ok = $false
	if (Test-Path $marker) {
		try { $ok = ((Get-Content $marker -Raw | ConvertFrom-Json).name -eq "oh-my-pi-zh") } catch { $ok = $false }
	}
	if (-not $ok) {
		Write-Host "[omp-zh] 目标目录已存在且不是本项目副本，已中止以免误删:" -ForegroundColor Red
		Write-Host "  $dir" -ForegroundColor Red
		Write-Host "  请改用其他目录（用 -Dir 或设置环境变量 OMP_ZH_DIR）后重试。" -ForegroundColor Yellow
		[void](Try-Remove $tmp)
		return
	}
	$old = "$dir.old-" + (Get-Date -Format "yyyyMMddHHmmss")
	try { Move-Item $dir $old -ErrorAction Stop } catch {
		Write-Host "[omp-zh] 无法替换已存在的目录（可能被其他程序占用）:" -ForegroundColor Red
		Write-Host "  $dir" -ForegroundColor Red
		Write-Host "  请关闭占用它的程序后重试。" -ForegroundColor Yellow
		[void](Try-Remove $tmp)
		return
	}
}
$parent = Split-Path -Parent $dir
if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
Move-Item $inner.FullName $dir
[void](Try-Remove $tmp)
if ($old -and -not (Try-Remove $old)) { Say "旧版本残留在 $old，可手动删除。" }
Say "已就位: $dir"

if ($ArgNoApply -or $env:OMP_ZH_SKIP_APPLY -eq "1") { Say "已跳过应用步骤（-NoApply）。"; return }

# ---------- 3. 确保上游 omp 已安装 ----------
$ompPkg = Join-Path $env:USERPROFILE ".bun\install\global\node_modules\@oh-my-pi\pi-coding-agent"
if (-not (Test-Path $ompPkg)) {
	Say "未检测到上游 omp，正在安装 @oh-my-pi/pi-coding-agent@latest ..."
	& bun add -g "@oh-my-pi/pi-coding-agent@latest"
	if ($LASTEXITCODE -ne 0) {
		Write-Host "[omp-zh] 安装上游 omp 失败，请手动执行: bun add -g @oh-my-pi/pi-coding-agent" -ForegroundColor Red
		return
	}
}

# ---------- 4. 应用汉化 ----------
Say "应用汉化 ..."
& bun (Join-Path $dir "scripts\apply.ts")
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
	Write-Host "[omp-zh] 完成！" -ForegroundColor Green
	Write-Host "  在 CMD / PowerShell 里直接运行 omp 即为中文界面。"
	Write-Host "  以后 omp 升级后首次启动会自动重打汉化；也可随时重跑本命令更新。"
	Write-Host "  卸载: bun remove -g @oh-my-pi/pi-coding-agent-zh 并删除 $env:USERPROFILE\.local\bin\omp.cmd"
} else {
	Write-Host "[omp-zh] 汉化应用失败（退出码 $code）。" -ForegroundColor Red
	Write-Host "  可手动重试: bun `"$dir\scripts\apply.ts`""
}
