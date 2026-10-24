@echo off
chcp 65001 >nul
setlocal
where node >nul 2>nul
if errorlevel 1 (
  set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
) else (
  set "NODE=node"
)
if /i not "%NODE%"=="node" if not exist "%NODE%" (
  echo 没找到 node，请先安装 DSH 桌面版或 Node.js
  pause
  exit /b 1
)
"%NODE%" "%~dp0install.mjs" %*
pause
