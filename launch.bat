@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  Nuomi IDE 启动器  ——  双击即可运行（无需安装、零成本）
rem  1) 定位/准备糯米工具链（nuomi.exe / nucutil.exe）
rem  2) 用本机 Node 启动本地服务并自动打开浏览器
rem  工具链来源（按优先级）：
rem    a) 环境变量 NUOMI_HOME（指向含 nuomi.exe 的目录）
rem    b) 同级目录 Nuomi / mochi / nuomi 里含 nuomi.exe 者
rem    c) 子目录 toolchain\nuomi.exe
rem    d) 都没有 → 首次自动从 GitHub 克隆 Ryan-cpu-lang/Nuomi 并构建
rem ============================================================
cd /d %~dp0

set "NODE=C:\Users\RAYN\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" set "NODE=node.exe"

rem ---- 1. 定位工具链 ----
if defined NUOMI_HOME (
  echo [IDE] 使用环境变量 NUOMI_HOME=%NUOMI_HOME%
  goto :havehome
)
for %%D in (Nuomi mochi nuomi) do (
  if not defined NUOMI_HOME (
    if exist "..\%%D\nuomi.exe" set "NUOMI_HOME=..\%%D"
  )
)
if not defined NUOMI_HOME (
  if exist "toolchain\nuomi.exe" set "NUOMI_HOME=toolchain"
)

:havehome
if not defined NUOMI_HOME (
  echo [IDE] 未找到 Nuomi 工具链，正在从 GitHub 克隆并构建...
  git clone https://github.com/Ryan-cpu-lang/Nuomi.git "..\Nuomi" >nul 2>&1
  if exist "..\Nuomi\nuomi.exe" (set "NUOMI_HOME=..\Nuomi") else (
    if exist "..\Nuomi\build.bat" call "..\Nuomi\build.bat"
    if exist "..\Nuomi\nuomi.exe" set "NUOMI_HOME=..\Nuomi"
  )
)

if not defined NUOMI_HOME (
  echo [IDE] 无法获取 Nuomi 工具链。
  echo   请手动设置 NUOMI_HOME 环境变量指向含 nuomi.exe 的目录，
  echo   或把 Nuomi 仓库克隆到本目录的同级位置（..\Nuomi）。
  pause
  exit /b 1
)

rem ---- 确保已编译 ----
if not exist "%NUOMI_HOME%\nuomi.exe" (
  echo [IDE] 工具链不完整（缺 nuomi.exe），尝试构建...
  if exist "%NUOMI_HOME%\build.bat" call "%NUOMI_HOME%\build.bat"
)
if not exist "%NUOMI_HOME%\nuomi.exe" (
  echo [IDE] 构建失败：请确认已安装 clang/gcc/tcc 之一，并正确设置 NUOMI_HOME。
  pause
  exit /b 1
)

echo [IDE] 使用工具链: %NUOMI_HOME%

rem ---- 2. 启动 IDE 服务（会自带浏览器） ----
echo [IDE] 启动 Nuomi IDE ...
"%NODE%" "%~dp0server.js"
endlocal
