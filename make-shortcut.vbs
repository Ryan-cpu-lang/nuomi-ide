' 为 Nuomi IDE 生成桌面快捷方式（带 nuomi.ico 图标）
' 用法：双击本文件，或在命令行 cscript //nologo make-shortcut.vbs
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = WScript.ScriptFullName
here = fso.GetParentFolderName(scriptPath)

Set WshShell = CreateObject("WScript.Shell")
desktop = WshShell.SpecialFolders("Desktop")

Set lnk = WshShell.CreateShortcut(desktop & "\Nuomi IDE.lnk")
lnk.TargetPath = here & "\launch.bat"
lnk.WorkingDirectory = here
lnk.IconLocation = here & "\nuomi.ico,0"
lnk.Description = "Nuomi IDE - 糯米语言集成开发环境"
lnk.WindowStyle = 1
lnk.Save

WScript.Echo "created: " & desktop & "\Nuomi IDE.lnk"
