<div align="center">


# 🧥 反穿衣工作台 — 本地个人工作台

基于 **Electron 45 + Node.js** 的 Windows 本地工作台，提供待办、专注计时、Markdown 笔记、网页收藏、文库阅读和剪贴板历史。笔记等文档可在数据目录中用其他 Markdown 编辑器打开。
**所有数据默认本地文件存储，不上传云端。**
<img width="1672" height="941" alt="反穿衣工作台：科研效率空间" src="https://github.com/user-attachments/assets/920699c7-5d37-47dc-9ba8-c9e8683ac06a" />

![Electron](https://img.shields.io/badge/Electron-45.3.1-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-r160%2Fr187-050505?logo=three.js&logoColor=white)
![Storage](https://img.shields.io/badge/Markdown%20%2B%20JSON-local-003b57)
![Version](https://img.shields.io/badge/version-23.0.2-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

> **源码范围**：本仓库源码对应 **V23.0.2 开发副本的架构重构阶段一**，不包含开屏录音、原首页衔尾蛇场景、Wallpaper Engine 实时场景组件、翻译模型与词典。开屏播放项目生成的画面与音效，首页提供衔尾蛇占位，壁纸仍可用本地图片与视频。缺少模型与词典时，翻译和查词显示资源不可用。
>
> 正式发布的GitHub Release中成品功能更完整，两者不要混为一谈。GitHub Release中提供一个 Windows x64 ZIP。用户完整解压后双击 `ReverseWear.exe`，即可使用笔记、PDF 阅读、计时和剪贴板。按已确认的方案，**优先内置 Argos 英中双向离线翻译，词典另按包内说明添加**。

## ✨ 功能特性

### 🖥️ 开屏动画

冷启动播放 **Three.js 三维开屏**，点击画面或按 `Enter` / `空格` 确认两次进入，按 `N` 切换**晨光 / 夜金**两套风格，点「跳过」或按 `Esc` 直接进入工作台。「设置 → 开屏动画」可调播放频率、玻璃、身份、语音与音效，也能直接预览或试听；「允许跳过开屏」同时控制两个入口。三维场景异步分段生成，开屏期间暂缓首页衔尾蛇，释放画布后首页重新挂载。**源码候选不附带开屏录音**，仅保留 `voice/manifest.json` 与 `SOURCES.md` 声明来源，开屏照常播放项目生成的画面与音效。

### 🏠 首页工作台

左侧「今天」聚合**提示词、最近剪贴、今日待办**，右侧时钟与计时紧凑排布，下方是**衔尾蛇（Ouroboros）**交互展示——可拖动旋转与缩放，另有**正方行动画**、**翻译卡片**、阴阳历与秒表。首页采用**等宽双栏 + 880px 宽度断点**，窄窗左栏在先，动画按宽度确定同等高度，超出窗口可纵向滚动。四种尺寸（1920×1080 / 1320×890 / 1366×768 / 720×620）下位置与宽度已逐一比对。**源码候选只提供衔尾蛇占位**，原场景文件不在仓库内。

### ⏱️ 专注计时

快捷时长 `25 / 15 / 45 / 60` 分钟与自定义时长，`空格` 开始 / 暂停、`F` 全屏、`H` 沉浸、`R` 重置；支持倒计时与正计时两种模式、目标时间设定与提示音。计时区与底部操作区各自独立成卡，适配专注场景。

### 🖼️ 壁纸库与场景

支持**图片、视频、网页**与 **Wallpaper Engine 的 431960 文件夹**目录导入，可按文件名或壁纸名称排序，轮播、随机切换。首页衔尾蛇不占用壁纸库。毛玻璃材质提供**原生模糊半径可调**，另有雾灰 / 海蓝 / 鼠尾草 / 暮紫 / 砂金五套主题色与浅色 / 深色 / 跟随系统三种模式。**源码候选不含 Wallpaper Engine 实时场景运行组件**，本地图片与视频可正常使用。

### 📋 剪贴板

**整页历史**，可分别批量复制文字或文件；`Alt+V` 打开快捷浮窗，标题栏三按钮可收起、最小化、最大化或还原，按住标题栏空白处或底部空白边拖动。系统剪贴板监听由独立桌面套件与 C# 原生桥处理。

### 🔖 收藏与网页

三栏布局：左侧目录树，中间关联 **Markdown 笔记**，右侧**内嵌网页**。回车直接打开地址，点「保存并打开」才写入收藏；内嵌网页打不开时可重试或在系统默认浏览器打开。收藏网页、关联笔记、速记与日报周报均支持**真实文件夹树**，右键新建内容或目录，右键记录「移动到」。磁盘根为 `Documents/Links`、`Documents/LinkNotes/<链接ID>`、`Documents/Notes`、`Documents/Memos`、`Documents/Daily`、`Documents/Weekly`。

### 📝 笔记与文库

Markdown 支持**阅读、实时预览与源码**三种模式，笔记模板在「设置 → 外观 → 设置」管理，工具行选中即插入，`Ctrl+S` 保存。**文库**支持 PDF 连续跨页阅读，PDF、Markdown 与 DOCX 统一支持纵向滚轮、`Ctrl+滚轮` 缩放与放大后的横向滚动。PDF 缩放合并输入：先按鼠标位置缩放旧画面，停顿约 120ms 后只按最终倍率绘制，可见页优先、按滚动方向预绘一页，离屏缓存上限两页且合计不超过 1600 万像素。选中文字可送翻译栏，笔记支持跳页。数学公式与 Obsidian 双链按原文显示。

### 🌍 翻译与生词本

英中双向自动 / 手动翻译，支持模型切换、查词入**生词本**、**个人术语表**提示、复制粘贴与收藏。翻译词条保留释义、原句或来源，并维护复习日期、间隔与次数；生词本记录学习进度，术语表记录翻译约定，两者分开管理。**源码候选不附带翻译模型与词典**，缺少资源时翻译与查词显示不可用。已有兼容资源时放到数据目录的 `Translation/Models`、`Translation/Dictionaries`、`Translation/Runtime`，或用 `REVERSEWEAR_TRANSLATION_ASSETS` 指向资源根，用 `STILLTIME_PYTHON` 指定解释器路径；模型格式见 `Source/desktop_translation_worker.py`。

### 💡 灵感与生活

灵感包含**收件箱、灵感卡片、想法看板、灵感板**四种记录形态；快速记录写入 `Documents/Inbox/`，整理后可转为卡片。想法看板按卡片状态分列，灵感板保存作品截图、标题、关联网址与借鉴点。生活与思考、周报、文章收集箱、链接库与标签建议各自独立成页。

### 🔍 全局搜索

`Ctrl+K` 唤起，跨页面检索收藏、笔记、链接与文章，回车直达。

### ⚙️ 外观与设置

主题由**显示模式 × 主题色 × 界面材质**三个独立维度组成。毛玻璃材质可调模糊半径，CSS 变量体系分为基础令牌、外观令牌与材质令牌，避免模块局部值误用为全局值。开屏、剪贴、翻译、壁纸等各自有独立设置入口。

## ⌨️ 快捷键

| 快捷键           | 功能                |
| ---------------- | ------------------- |
| `Alt + V`        | 打开剪贴板快捷浮窗  |
| `Alt + I`        | 快速捕捉窗口        |
| `Ctrl + K`       | 全局搜索            |
| `Ctrl + S`       | 保存当前笔记 / 收藏 |
| `空格`           | 专注计时开始 / 暂停 |
| `F`              | 计时全屏            |
| `H`              | 计时沉浸模式        |
| `R`              | 计时重置            |
| `N`              | 开屏切换晨光 / 夜金 |
| `Enter` / `空格` | 开屏确认进入        |
| `Esc`            | 跳过开屏 / 关闭弹窗 |

`Alt+V` 与 `Alt+I` 由全局快捷键注册，可在设置中改键或禁用。

## 🛠️ 技术栈

| 层              | 技术                                                         |
| --------------- | ------------------------------------------------------------ |
| 界面层 Renderer | 原生 HTML / ES Modules（`<script type="module">`，`dist/*.mjs`），无 Vue / React 框架；Three.js 负责开屏与衔尾蛇 |
| 桥接层 Preload  | `preload.cjs` / `suite-preload.cjs` / `capture-preload.cjs` 按窗口分别暴露窄接口，不向页面暴露 Node.js 或通用 IPC 对象 |
| 通信层 IPC      | `ipcRenderer.invoke` ↔ `ipcMain.handle` 配对契约，通道写入队列与授权窗口由 `ipc/contract.mjs` 统一登记，改动后运行 `npm run ipc:generate` 与 `npm run ipc:check` |
| 应用服务层 Main | Electron 主进程 Node.js ES Modules；`main/` 分模块管窗口、开屏、捕捉、浏览器实例；`desktop_*.mjs` 负责各业务域；C# 原生桥由 `desktop_suite/WindowsBridge.cs` 在启动时编译，用 .NET Framework 4.x 的 64 位编译器，可用 `WINDOWS_BRIDGE_CSC` 指定编译器路径 |
| 数据层 Storage  | JSON + Markdown 文件（front-matter），源码候选默认数据根 `%LOCALAPPDATA%/ReverseWear/Workbench`，可在「数据与备份」调整；窗口状态经主进程持久化，外观偏好存 localStorage |
| 文档处理        | markdown-it 15.0.3、mammoth 1.13.0、turndown 7.2.5、@mozilla/readability 0.6.0、linkedom 0.18.15、sanitize-html 2.18.2；PDF 阅读用随源码附带的 PDF.js 6.5.438 |
| 离线翻译        | Python worker（`desktop_translation_worker.py`），模型与词典不随源码分发，需自备资源 |
| 样式            | 手写 CSS 约 109 个自定义变量，多套主题文件（appearance.css 外观、glass-theme.css 毛玻璃、focus-theme.css 专注、workbench-layout.css 布局修正） |
| 打包            | electron-builder 26.18.0，由锁文件固定；可构建目录版与单文件便携版 |

## 🚀 快速开始

需要 Windows x64、Node.js 24、npm，以及 Windows .NET Framework 4.x 自带的 64 位 C# 编译器。Electron 45.3.1 与 electron-builder 26.18.0 由锁文件固定。首次安装依赖需要网络，首次构建 electron-builder 可能需要下载 Windows 打包工具。

从仓库根目录在 PowerShell 运行：

```powershell
Set-Location Source
npm ci
npm start
```

启动会从 `desktop_suite/WindowsBridge.cs` 编译本地助手。默认编译器在 Windows 的 `Microsoft.NET/Framework64/v4.0.30319` 目录，可通过 `WINDOWS_BRIDGE_CSC` 指定同类编译器的完整路径。首次启动默认数据放入 `%LOCALAPPDATA%/ReverseWear/Workbench`，可在「数据与备份」中调整，程序保留所选目录中的 Markdown 文件和设置格式。

测试与检查：

```powershell
npm test
npm run architecture:check
npm run ipc:check
npm run verify
```

`verify` 启动隔离 Electron 套件，检查无可选资源时的开屏跳过、时钟、笔记与文库。旧版 QA 脚本留在 `qa/`，其中衔尾蛇、语音、场景壁纸和模型推理专项需要各自素材。

构建 Windows 程序，在 `Source/` 完成 `npm ci` 后运行：

```powershell
# 目录版，完整保留 win-unpacked 内的文件
npm run build -- ./release directory

# 单文件便携版
npm run build -- ./release portable
```

目录版入口为 `release/win-unpacked/ReverseWear.exe`。正式发布的 V23.0.2 为目录便携版，整个 `CodexV23.0.2` 文件夹必须保留，直接运行 `ReverseWear.exe`。

## 📂 目录结构

```
仓库根目录/
├── README.md                       # 本文件
├── THIRD_PARTY_NOTICES.md          # 第三方组件来源与许可
└── Source/
    ├── package.json / package-lock.json
    ├── main.mjs / main/            # 主进程装配、开屏、捕捉、浏览器实例
    ├── preload.cjs / suite-preload.cjs / capture-preload.cjs
    ├── ipc/contract.mjs            # IPC 通道契约与授权登记
    ├── desktop_*.mjs               # 剪贴、翻译、词典、灵感、周报、壁纸等业务服务
    ├── desktop_suite/              # 桌面套件与 C# 桥源码 WindowsBridge.cs
    ├── desktop_translation_worker.py
    ├── workbench-store.mjs / research-store.mjs
    ├── qa/                         # 架构门禁、便携验收、性能脚本
    ├── tests/                      # Node 测试
    └── dist/                       # Renderer 源码：70 个文件、35 个 mjs、30 个 css
        ├── index.html / app.mjs    # 外壳与入口装配
        ├── home-dashboard.mjs      # 首页工作台
        ├── home-timer.mjs / timer.mjs
        ├── ouroboros-frame.mjs     # 衔尾蛇占位
        ├── startup/                # 开屏三维场景（录音仅留清单与来源说明）
        ├── clipboard-page.mjs      # 剪贴板历史
        ├── web-collection.mjs      # 收藏与内嵌网页
        ├── note-workspace.mjs      # 笔记编辑器
        ├── workbench-pdf.mjs / vendor/pdfjs
        ├── translation.mjs / life.mjs
        ├── ideas.mjs / idea-kanban.mjs / inspiration-board.mjs
        ├── global-search.mjs
        └── workbench-settings.mjs
```

## 🔒 数据与隐私

源码候选首次启动默认数据根为 `%LOCALAPPDATA%/ReverseWear/Workbench`，可在「数据与备份」中调整；正式发布版的数据根由发布配置决定。首启自动生成 `Documents/`、`Settings/Stilltime/`、`Runtime/Stilltime/Chromium/`、`AI-Mirror/` 等目录。所有业务文档以 UTF-8 Markdown 与 JSON 落盘，肉眼可读、可直接搬迁。

| 目录                                                         | 内容                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `Documents/Notes/`                                           | 普通笔记，外部 Markdown 可直接扫描发现，首次读取不改写文件 |
| `Documents/Memos/`                                           | 速记                                                       |
| `Documents/Daily/` / `Documents/Weekly/`                     | 日报与周报                                                 |
| `Documents/Links/` / `Documents/LinkNotes/<链接ID>/`         | 收藏与关联笔记                                             |
| `Documents/Prompts/`                                         | 提示词，点卡片复制完整 Markdown                            |
| `Documents/Templates/`                                       | Markdown 模板                                              |
| `FolderMoveBackups/`                                         | 无 ID 外部记录首次移动前的原件备份                         |
| `Translation/Models/` / `Translation/Dictionaries/` / `Translation/Runtime/` | 自备的翻译模型、词典与运行时，源码候选不附带               |

便携版把 `Documents/` 放在 EXE 同级即可在另一环境复用资料。首次移动无 ID 的记录前，原件存入 `FolderMoveBackups/`。程序保留所选目录中的 Markdown 文件和设置格式，不改写外部文档。

## 使用截图 
<img width="1332" height="888" alt="微信图片_20261118172946_473_550" src="https://github.com/user-attachments/assets/b45daa3e-085f-4aa4-b840-eba19eeef34e" />
<img width="1332" height="888" alt="微信图片_20261118172946_474_550" src="https://github.com/user-attachments/assets/77bb3788-7a53-4481-bfe2-2fcbd11261de" />
<img width="3840" height="2080" alt="微信图片_20261118172946_480_550" src="https://github.com/user-attachments/assets/538571a4-2465-4d24-851c-aff0b7ce79b4" />
<img width="2638" height="1780" alt="微信图片_20261118172946_479_550" src="https://github.com/user-attachments/assets/18df568a-ba3e-4718-9f15-a0a232c84f60" />
<img width="1332" height="888" alt="微信图片_20261118172946_475_550" src="https://github.com/user-attachments/assets/6a923d6d-73a2-4784-8416-cf8f7d88367b" />


## ✅ 验收状态

`npm test`、`npm run architecture:check`、`npm run ipc:check`、`npm run verify` 是仓库自带的检查入口。`verify` 在无可选资源的隔离环境下检查开屏跳过、时钟、笔记与文库。

正式 V23.0.2 发布时记录：159 项 Node 测试通过；默认 20 个 Electron 套件中 19 个全量通过，另 1 个交互与翻译套件修正前序残留冲突对话框后随相关三个套件复测通过。架构门禁结果：112 个模块、0 个静态依赖循环、47 条既有跨层边、14 个 preload 直连、17 个超大 JS、1 个超大 CSS、2 个装配债务入口、60 个已覆盖运行依赖。这些数字来自开发副本的验收记录，公开候选未重新逐项跑全量验收。

## 📄 配套文档

- `THIRD_PARTY_NOTICES.md`：第三方组件来源与许可，含 PDF.js、markdown-it、Three.js 及翻译资源的上游声明
- 开发副本另有 `HANDOFF.md`（版本沿革与验收）、`CONTEXT.md`（术语边界与五层职责）、`DESIGN.md`（主题维度与 CSS 令牌），不在公开候选内

## 📄 许可证

本仓库的原创内容采用 MIT License 开源。第三方文档和外部链接内容仍遵循各自权利人的许可条款。

第三方组件的许可与来源见 `THIRD_PARTY_NOTICES.md`。其中 PDF.js 6.5.438 为 Apache-2.0，markdown-it 15.0.3 与 Three.js 为 MIT，翻译资源 ECDICT 为 MIT、CC-CEDICT 为 CC BY-SA 4.0、OPUS-MT 英译中为 Apache-2.0、中译英为 CC BY 4.0。本候选不分发这些模型、词典、量化文件或翻译运行时。

如果你也想整理自己的笔记但是不想上传到别人的服务器上，欢迎试用、分享，并为这个项目点一个 Star。
