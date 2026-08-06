@echo off
REM omp-hanhua — omp 简体中文汉化补丁 (Windows cmd 入口)
REM 用法: apply.cmd [-Force] [-BunGlobal <path>] [-LauncherDir <path>]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply.ps1" %*
exit /b %errorlevel%
