# 反穿衣工作台 · ReverseWear

反穿衣是一个 Windows 本地工作台，提供待办、专注计时、Markdown 笔记、网页收藏、文库阅读和剪贴板历史。笔记等文档可在数据目录中用其他 Markdown 编辑器打开。

此源码候选基于 V23.0.2 开发副本的架构重构阶段一。源码位于 `Source/`，其中 `Source/dist/` 是 Electron Renderer 的 HTML、CSS 和 JavaScript 源码。

## 运行和测试

使用 Windows x64、Node.js 24、npm，以及 Windows .NET Framework 4.x 自带的 64 位 C# 编译器。Electron 45.3.1 和 electron-builder 26.18.0 由锁文件固定。PowerShell 中从仓库根目录运行：

```powershell
Set-Location Source
npm ci
npm start
```

启动会从 `desktop_suite/WindowsBridge.cs` 编译本地助手。默认编译器位于 Windows 的 `Microsoft.NET/Framework64/v4.0.30319/csc.exe`，可通过 `WINDOWS_BRIDGE_CSC` 指定同类编译器的完整路径。首次安装依赖需要网络。

首次启动默认将工作台数据放入 `%LOCALAPPDATA%/ReverseWear/Workbench`。数据位置可在「数据与备份」中调整。程序保留所选目录中的 Markdown 文件和设置格式。

```powershell
npm test
npm run architecture:check
npm run ipc:check
npm run verify
```

`verify` 启动隔离 Electron 套件，检查无可选资源时的开屏跳过、时钟、笔记与文库。旧版 QA 脚本留在 `qa/`，其中原衔尾蛇、语音、场景壁纸和模型推理专项需要各自的素材。

## 构建 Windows 程序

在 `Source/` 完成 `npm ci` 后运行：

```powershell
# 目录版，完整保留 win-unpacked 内的文件
npm run build -- ./release directory

# 单文件便携版
npm run build -- ./release portable
```

首次构建时 electron-builder 可能需要下载 Windows 打包工具。目录版入口为 `release/win-unpacked/ReverseWear.exe`。

## 可选资源

候选源码不附带开屏录音、原首页衔尾蛇场景、Wallpaper Engine 实时场景运行组件、翻译模型或词典。开屏仍可播放项目生成的画面和音效，首页提供衔尾蛇占位，壁纸仍可使用本地图片和视频。缺少模型与词典时，翻译和查词显示资源不可用。

已有兼容翻译资源时，可将它们放进数据目录下的 `Translation/Models`、`Translation/Dictionaries` 和 `Translation/Runtime`，或把 `REVERSEWEAR_TRANSLATION_ASSETS` 设置为该资源根。用 `STILLTIME_PYTHON` 提供解释器路径。模型的具体格式见 `Source/desktop_translation_worker.py`。

项目源码许可待确认。第三方组件的许可与来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
