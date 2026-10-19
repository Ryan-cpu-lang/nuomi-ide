# 🍡 Nuomi IDE — 糯米语言集成开发环境

PyCharm 风格的糯米语言（Nuomi）桌面 IDE：**双击启动、零安装、零成本**。
底层是一个本地 Web 服务（Node，纯内置模块，无需 `npm install`）+ 浏览器内核界面。

> 本仓库是 Nuomi 语言的**独立 IDE**（与语言本体 [`Ryan-cpu-lang/Nuomi`](https://github.com/Ryan-cpu-lang/Nuomi) 分开维护）。IDE 本身不含编译器，运行时会自动定位或拉取 Nuomi 工具链。

## ✨ 功能
- **语法高亮编辑器**：括号配色、关键字/内置函数/字符串/数字/注释分类着色，行号、缩进辅助。
- **资源管理器**：左侧文件树，直接打开/新建/保存工作区里的 `.nuomi` 文件。
- **运行**（解释器）：`nuomi.exe 文件.nuomi` 的实时输出。
- **编译运行**：`nuomi -c` 编译为 `.nuc`，再用 `nucutil run` 在真机入口跑，显示入口返回值。
- **交互式 REPL**：持久会话（定义的变量/函数跨行保留），与命令行的 `nuomi` REPL 一致。
- **深色 / 浅色主题**切换（记忆选择）。
- **📦 导出 `.nup`**：把当前 `.nuomi` 编译成 `.nuc` 并打包为 NUP 安装包（一键上架雏形）。
- **桌面快捷方式**：运行 `make-shortcut.ps1` / `make-shortcut.vbs` 即可在桌面生成带 `nuomi.ico` 图标的「Nuomi IDE」快捷方式。
- 首次启动自动把 Nuomi 仓库的示例拷进工作区，并生成 `welcome.nuomi` 上手引导。

## 🚀 使用
1. 双击 **`launch.bat`**。
2. 它会自动确定糯米工具链（`nuomi.exe` / `nucutil.exe`）的位置——按以下顺序：
   - 环境变量 `NUOMI_HOME`（指向含 `nuomi.exe` 的目录）；
   - 本目录同级的 `Nuomi` / `mochi` / `nuomi` 仓库；
   - 子目录 `toolchain/`；
   - **都没有**：首次自动 `git clone` `Ryan-cpu-lang/Nuomi` 并构建。
3. 随后自动打开浏览器到 `http://localhost:7177`。
4. 左边选文件 → 中间写代码 → 下方「▶ 运行」或切到「REPL」标签交互。

> 关闭 IDE：直接关掉启动器那个黑窗口（服务进程一并结束）。

## ⌨️ 快捷键
- `Ctrl/Cmd + S`：保存
- `F5`：运行
- `Tab`：插入两个空格缩进
- REPL 输入框回车：求值当前行

## ⚙️ 配置（`ide.config.json`）
| 字段 | 含义 | 默认 |
|------|------|------|
| `port` | 本地服务端口 | `7177` |
| `nuomi_home` | 工具链目录（含 `nuomi.exe`/`nucutil.exe`），相对本仓库根目录 | `../Nuomi` |
| `workspace` | 工作区目录（用户文件存放处），相对本仓库根目录 | `workspace` |

> 环境变量 `NUOMI_HOME` 优先级高于配置文件；手动启动时可临时覆盖：
> ```bat
> set NUOMI_HOME=D:\path\to\Nuomi
> node server.js
> ```

## 🗂️ 目录
```
nuomi-ide/
├── launch.bat          # 双击启动（自动定位/拉取工具链）
├── server.js           # 零依赖 Node 后端（文件/运行/REPL/打包 API）
├── ide.config.json     # 配置
├── nuomi.ico           # 应用图标（桌面快捷方式用）
├── make-shortcut.ps1   # 生成桌面快捷方式（PowerShell）
├── make-shortcut.vbs   # 生成桌面快捷方式（VBScript，无 PowerShell 时用）
├── public/             # 前端界面
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── workspace/          # 用户工作区（首次自动预载示例，已 gitignore）
```

## 🔧 手动启动（可选）
```bat
:: 用任意 node 启动（需先确保 NUOMI_HOME 可用）
node server.js
:: 或指定端口
set PORT=8080 && node server.js
```

## 📌 说明
- 所有文件读写都限制在 `workspace/` 内（路径穿越会被拒绝），安全。
- REPL 是长驻进程；「↻ REPL」按钮会重启它。
- 编辑器里「编译运行」跑的就是 `dist/novus/*.nuc` 同款 NUC 产物。
- 语法高亮词表与语言真实实现对齐：`eval.c` 的 9 个特殊形式 + `native.c` 的 27 个原生函数。

## 🖥️ 桌面快捷方式
双击 **`make-shortcut.vbs`**（或 `powershell -ExecutionPolicy Bypass -File make-shortcut.ps1`），
会在你的桌面生成「Nuomi IDE.lnk」——带 `nuomi.ico` 图标、指向 `launch.bat`。之后直接双击它就能开 IDE。

## 📦 导出 `.nup`（预览版）
点顶栏「📦 导出 .nup」会把当前文件编译为 `.nuc`，再包成 NUP 安装包（store-only、未签名），
并用「校验回读」面板展示内部结构（魔数 / 包名 / 文件表 / Manifest）。

> ⚠️ **当前为草案实现**：NUP 规范存在两个 P0 问题（头部 64 vs 88 字节、魔数字节序反了），
> 此处按核对清单建议的修正方案实现（64 字节头部 + 正确魔数 `NUP!`）。
> 待 liam 修复 P0 定稿后，导出会同步启用正式校验与签名。导出的 `.nup` 目前仅供结构验证与流程联调，
> 尚未被系统安装器消费。
