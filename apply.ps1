# omp-hanhua — omp 简体中文汉化补丁
# 用法: ./apply.ps1 [-Force] [-BunGlobal <path>] [-LauncherDir <path>]
#   -Force        版本一致时也强制重打
#   -BunGlobal    覆盖 bun 全局 node_modules 路径(自动检测失败时用)
#   -LauncherDir  覆盖启动器安装目录(默认 ~/.local/bin)
param(
	[switch]$Force,
	[string]$BunGlobal = "",
	[string]$LauncherDir = ""
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------- 路径定位 ----------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$patchPath = Join-Path $scriptDir "hanhua.patch"

function Get-BunGlobalModules {
	if ($BunGlobal) { return $BunGlobal }
	# 优先从 `bun pm bin -g` 推断: <bunRoot>/bin -> <bunRoot>/install/global/node_modules
	try {
		$binDir = (& bun pm bin -g 2>$null | Select-Object -Last 1).Trim()
		if ($binDir) {
			$bunRoot = Split-Path -Parent $binDir
			$candidate = Join-Path $bunRoot "install\global\node_modules"
			if (Test-Path $candidate) { return $candidate }
		}
	} catch { }
	# 常见路径兜底
	foreach ($candidate in @(
		(Join-Path $HOME ".bun\install\global\node_modules"),
		(Join-Path $env:USERPROFILE ".bun\install\global\node_modules")
	)) {
		if ($candidate -and (Test-Path $candidate)) { return $candidate }
	}
	return ""
}

$globalModules = Get-BunGlobalModules
if (-not $globalModules -or -not (Test-Path $globalModules)) {
	Write-Host "[omp-hanhua] ERROR: 找不到 bun 全局 node_modules。请确认已安装 bun,或用 -BunGlobal 指定路径。"
	exit 1
}

$src = Join-Path $globalModules "@oh-my-pi\pi-coding-agent"
$dst = Join-Path $globalModules "@oh-my-pi\pi-coding-agent-zh"

if (-not (Test-Path (Join-Path $src "package.json"))) {
	Write-Host "[omp-hanhua] ERROR: 未找到 omp 源码包: $src"
	Write-Host "[omp-hanhua] 请先安装: bun add -g @oh-my-pi/pi-coding-agent"
	exit 1
}
if (-not (Test-Path $patchPath)) {
	Write-Host "[omp-hanhua] ERROR: 未找到补丁文件: $patchPath"
	exit 1
}

# ---------- 版本检测 ----------
$versionFile = Join-Path $HOME ".omp-hanhua-version"
$srcVer = (Get-Content (Join-Path $src "package.json") -Raw | ConvertFrom-Json).version
$patchedVer = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { "" }

if (-not $Force -and (Test-Path (Join-Path $dst "package.json")) -and $srcVer -eq $patchedVer) {
	Write-Host "[omp-hanhua] 汉化副本已是最新 (v$srcVer),无需重打。"
	exit 0
}

Write-Host "[omp-hanhua] 正在重建汉化副本 ..."
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
Copy-Item -Recurse -Force $src $dst | Out-Null

Write-Host "[omp-hanhua] 正在应用补丁 ..."
Push-Location $dst
try {
	& git -c core.autocrlf=false apply --ignore-whitespace -p2 $patchPath 2>$null
	if ($LASTEXITCODE -ne 0) {
		& patch -p2 -i $patchPath 2>$null
	}
	if ($LASTEXITCODE -ne 0) {
		Write-Host "[omp-hanhua] ERROR: 补丁应用失败。可能 omp 已升级导致文案变更,请检查兼容性。原包未受影响。"
		exit 1
	}
} finally {
	Pop-Location
}

Set-Content -Path $versionFile -Value $srcVer -NoNewline

# ---------- 安装启动器 ----------
$cliPath = Join-Path $dst "src\cli.ts"
if (-not $LauncherDir) { $LauncherDir = Join-Path $HOME ".local\bin" }
New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null

if ($IsWindows -or $env:OS -match "Windows") {
	$launcher = Join-Path $LauncherDir "omp.cmd"
	$content = "@echo off`r`nbun `"$cliPath`" %*`r`n"
	Set-Content -Path $launcher -Value $content -Encoding Ascii -NoNewline
} else {
	$launcher = Join-Path $LauncherDir "omp"
	$content = "#!/usr/bin/env bash`n`n exec bun `"$cliPath`" `"`$@`"`n"
	Set-Content -Path $launcher -Value $content -Encoding Ascii -NoNewline
	if (Get-Command chmod -ErrorAction SilentlyContinue) { & chmod +x $launcher }
}

Write-Host "[omp-hanhua] 完成!汉化版 omp 已就绪 (v$srcVer)。"
Write-Host "[omp-hanhua] 启动器: $launcher"
$pathOk = $env:PATH -split ";" -contains $LauncherDir
if (-not $pathOk) {
	Write-Host "[omp-hanhua] 警告: $LauncherDir 不在 PATH 中,或排在 bun bin 之后。"
	Write-Host "[omp-hanhua] 请将其加入 PATH 并确保排在 bun bin 之前,或在原位置使用:`n  bun `"$cliPath`""
} else {
	Write-Host "[omp-hanhua] 现在直接运行 omp 即为汉化版。"
}
exit 0
