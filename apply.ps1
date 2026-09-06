# oh-my-pi-zh — omp 简体中文汉化 (Windows 入口)
# 全部逻辑在 scripts/apply.ts，本脚本只做参数转发。
# 用法: .\apply.ps1 [-Force] [-BunGlobal <path>] [-LauncherDir <path>] [--check] [--no-auto-heal]
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tsArgs = @()
foreach ($a in $args) {
	switch ($a) {
		"-Force" { $tsArgs += "--force" }
		"-BunGlobal" { $tsArgs += "--bun-global" }
		"-LauncherDir" { $tsArgs += "--launcher-dir" }
		default { $tsArgs += $a }
	}
}

& bun (Join-Path $scriptDir "scripts\apply.ts") @tsArgs
exit $LASTEXITCODE
