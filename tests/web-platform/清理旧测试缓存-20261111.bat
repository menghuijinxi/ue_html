@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleanup-test-cache-20261111.ps1" %*
pause
