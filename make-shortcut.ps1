# 为 Nuomi IDE 生成桌面快捷方式（带 nuomi.ico 图标）
# 用法：右键“使用 PowerShell 运行”，或：powershell -ExecutionPolicy Bypass -File make-shortcut.ps1
$ErrorActionPreference = 'Stop'
$here      = Split-Path -Parent $MyInvocation.MyCommand.Definition
$target    = Join-Path $here 'launch.bat'
$icon      = Join-Path $here 'nuomi.ico'
$ws        = New-Object -ComObject WScript.Shell
$desktop   = [Environment]::GetFolderPath('Desktop')
$lnkPath   = Join-Path $desktop 'Nuomi IDE.lnk'

if (-not (Test-Path $target)) { Write-Host "未找到 launch.bat，请在 nuomi-ide 目录内运行此脚本"; exit 1 }
if (-not (Test-Path $icon))  { Write-Host "未找到 nuomi.ico，将使用默认图标"; $icon = $target }

$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath        = $target
$sc.WorkingDirectory  = $here
$sc.IconLocation      = "$icon,0"
$sc.Description       = 'Nuomi IDE - 糯米语言集成开发环境'
$sc.WindowStyle       = 1   # 1 = 正常窗口
$sc.Save()
Write-Host "已创建桌面快捷方式: $lnkPath"
