# Workbench

Workbench 是一个面向 Windows 的多标签桌面 Web 客户端，适合集中打开内网站点、自托管服务和本地页面。

它基于 Electron 构建，不包含 Hermes Agent 本体，也不会在本机运行 AI 模型。你可以把它当成一个独立的工作台，用多个标签访问已经部署好的 Web 服务。

## 功能

- 多标签浏览，支持切换、关闭和拖拽排序
- 网址管理，可设置默认网址和标签别名
- 支持 HTTP、HTTPS、本地文件路径和 UNC 网络路径
- 登录 Cookie、标签页、窗口位置和应用设置持久化
- 跨域登录和 `window.open()` 页面继续在客户端内打开
- 深色、浅色主题
- 麦克风和摄像头权限开关
- Windows 开机自启，可随时启用或关闭
- 文件下载保存对话框和下载完成通知
- 页面无响应或渲染进程崩溃时，自动尝试恢复当前标签
- 右键菜单支持复制、粘贴、刷新和在系统浏览器中打开

## 系统要求

- Windows 10 或 Windows 11，64 位
- Node.js 18 或更高版本（仅源码运行和构建时需要）
- npm

普通用户安装打包后的 `.exe` 即可，不需要安装 Node.js。

## 安装

从项目的 GitHub Releases 页面下载最新的 Windows x64 安装包：

```text
workbench-Setup-<version>-win-x64.exe
```

运行安装程序后选择安装位置。覆盖安装新版本时会保留网址、标签、登录状态和开机自启设置。

Windows 可能会对未签名安装包显示 SmartScreen 提示。请先核对发布页提供的 SHA-256，再决定是否运行。

## 使用

首次启动时工作台为空白，不会自动打开任何网站。

1. 点击顶部的 `+`。
2. 输入网址或本地文件路径。
3. 如需长期保存，按 `Alt` 显示菜单栏，打开“网址 → 管理网址”。
4. 在网址管理中可以添加、删除、排序网址，设置默认项和标签别名。

开机自启、主题、麦克风和摄像头权限位于“设置”菜单。

### 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+T` | 新建标签页 |
| `F5` | 刷新当前页面 |
| `Shift+F5` | 强制刷新并忽略缓存 |
| `Ctrl+Shift+R` | 强制刷新并忽略缓存 |
| `Alt` | 显示应用菜单栏 |

## 从源码运行

```bash
npm install
npm start
```

当前项目使用 Electron 36。

## 构建 Windows 安装包

```bash
npm install
npm run dist:win
```

构建产物位于：

```text
release/workbench-Setup-<version>-win-x64.exe
```

发布前建议执行：

```bash
node --check main.js
node --check preload.js
node --check renderer-injections.js
npm run dist:win
```

## 项目结构

```text
.
├── main.js                 # Electron 主进程、标签管理、菜单和持久化
├── preload.js              # Web 页面与桌面端之间的受限桥接
├── renderer-injections.js  # 原生通知桥接
├── tabbar.html             # 顶部标签栏
├── settings.html           # 网址管理窗口
├── assets/                 # 图标和 NSIS 安装器扩展
├── package.json            # 依赖、脚本和打包配置
└── README.md
```

## 配置说明

应用设置保存在 Electron 的 `userData` 目录中，主要包括：

- `settings.json`：网址、默认网址、标签别名、媒体权限和主题
- `tabs.json`：当前标签及活动标签
- `window-state.json`：窗口大小、位置和最大化状态

所有内容标签共享 Electron 的持久化 session，因此同一登录系统下的 Cookie 可以在标签之间复用。

### 自签名证书

源码中的 `certHosts` 是允许绕过证书校验的主机白名单。公开部署或二次开发前，请在 `main.js` 中把它改成你自己的内网主机：

```js
const certHosts = ["your-internal-host"];
```

不要把证书错误设置为全局忽略。白名单之外的证书错误应保持拦截。

## 安全说明

Workbench 会加载你添加的网址，并允许这些页面使用持久化 Cookie。只添加你信任的站点。

- 不要在公开仓库中提交账号、密码、Token、Cookie 或私钥
- 不要提交个人 `settings.json`、`tabs.json` 或其他用户数据
- 不要把 `node_modules/`、`release/` 和临时测试目录提交到 Git
- 发布安装包前应计算并公开 SHA-256
- 若用于公网服务，建议使用由可信 CA 签发的 HTTPS 证书

## 已知限制

- 当前只构建和测试 Windows x64 安装包
- Chrome 扩展不能直接加载到这个独立 Electron 客户端
- 外部网站、认证服务或网络不可用时，客户端只能尝试恢复标签，无法保证页面一定成功加载
- 安装包目前未配置代码签名，Windows 可能显示安全提示

## 参与开发

提交问题时，请附上：

- Workbench 版本
- Windows 版本
- 可复现步骤
- 实际结果和预期结果
- 必要的日志或截图，提交前请删除敏感信息

提交代码前请至少完成语法检查和 Windows 安装包构建。

## 许可证

当前仓库尚未添加开源许可证。在添加许可证之前，代码默认不授予复制、修改或再分发权限。

如果准备将项目作为开源软件发布，请先选择并添加合适的 `LICENSE` 文件，例如 MIT、Apache-2.0 或 GPL-3.0。第三方依赖仍遵循各自的许可证。
