const { app, BrowserWindow, WebContentsView, dialog, Menu, Notification, screen, session, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const { injectNativeNotificationBridge } = require("./renderer-injections");

// Add trusted self-signed certificate hosts here for private deployments.
// Keep the public repository empty by default.
const certHosts = [];
const appTitle = "工作台";
const appId = "com.workbench.app";
const iconPath = path.join(__dirname, "assets", "hermes.ico");
const TABBAR_H = 38;
const themeColors = { dark: "#202020", light: "#f5f5f5" };

let mainWindow = null;
let tabbarView = null;
let views = [];
let activeId = null;
let nextId = 1;
let downloadHandlingReady = false;
let sessionDataFlushed = false;
let settingsWindow = null;
let currentTheme = "dark";
let updateCheckRunning = false;
let updateDownloadRunning = false;
let updateReadyToInstall = false;
let updateCheckInteractive = false;

const DEFAULT_URL_SHORTCUTS = ["F1", "F2", "F3", "F4"];
const RESERVED_SHORTCUTS = new Map([
  ["F5", "工作台使用 F5 刷新当前页面"],
  ["Ctrl+F5", "工作台使用 Ctrl+F5 强制刷新当前页面"],
  ["Shift+F5", "工作台使用 Shift+F5 强制刷新当前页面"],
  ["Ctrl+T", "工作台使用 Ctrl+T 新建标签页"],
  ["Ctrl+Shift+R", "工作台使用 Ctrl+Shift+R 强制刷新"],
  ["Alt+F4", "Windows 使用 Alt+F4 关闭窗口"],
  ["F10", "Windows/Electron 使用 F10 激活菜单栏"],
  ["F11", "浏览器通常使用 F11 切换全屏"],
  ["F12", "浏览器通常使用 F12 打开开发者工具"]
]);
const SHORTCUT_WARNINGS = new Map([
  ["F1", "F1 通常用于帮助；保存后将优先跳转网页"],
  ["F3", "F3 通常用于查找下一个；保存后将优先跳转网页"],
  ["F4", "F4 在部分网页中有自定义用途；保存后将优先跳转网页"]
]);

if (process.platform === "win32") {
  app.setAppUserModelId(appId);
}

// ── 改名迁移：Hermes → workbench（3.5.0）──────────────────────
// Electron userData 默认由 package.json 的 name 决定。历史正式版使用
// hermes-desktop（不是 productName hermes）；少数早期构建才使用 hermes。
// 新目录尚未有有效网址时，按该优先顺序迁移设置和窗口状态；逐项核验成功后删除旧目录。
function hasUsableSavedUrl(filePath, key) {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const values = key === "urls" ? state.urls : state.tabs;
    return Array.isArray(values) && values.some(normalizeTabUrl);
  } catch {
    return false;
  }
}

function migrateLegacyUserData() {
  try {
    const newPath = app.getPath("userData");
    const parent = path.dirname(newPath);
    if (!fs.existsSync(newPath)) fs.mkdirSync(newPath, { recursive: true });

    const newSettings = path.join(newPath, "settings.json");
    const newTabs = path.join(newPath, "tabs.json");
    const newHasUrls = hasUsableSavedUrl(newSettings, "urls") || hasUsableSavedUrl(newTabs, "tabs");
    if (newHasUrls) return;

    const configFiles = ["settings.json", "tabs.json", "window-state.json"];
    const oldPath = ["hermes-desktop", "hermes"]
      .map(name => path.join(parent, name))
      .find(dir => {
        const settings = path.join(dir, "settings.json");
        const tabs = path.join(dir, "tabs.json");
        return hasUsableSavedUrl(settings, "urls") || hasUsableSavedUrl(tabs, "tabs");
      });
    if (!oldPath) return;

    // 先复制，再逐项逐字节核验；只有完整成功才清理旧目录，避免迁移异常丢数据。
    for (const file of configFiles) {
      const src = path.join(oldPath, file);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(newPath, file);
      fs.copyFileSync(src, dest);
      if (!fs.existsSync(dest) || !fs.readFileSync(src).equals(fs.readFileSync(dest))) {
        throw new Error(`迁移校验失败：${file}`);
      }
    }
    fs.writeFileSync(path.join(newPath, ".migrated-from-hermes"), String(Date.now()), "utf8");
    fs.rmSync(oldPath, { recursive: true, force: true });
    console.log(`Migrated and removed legacy user data directory: ${path.basename(oldPath)}`);
  } catch (error) {
    console.error("Legacy user data migration failed:", error.message);
  }
}
if (process.platform === "win32" || process.platform === "linux") {
  migrateLegacyUserData();
}

function getAutoStartStatus() {
  if (process.platform !== "win32") {
    return { supported: false, enabled: false, error: "当前系统不支持此设置" };
  }

  try {
    const settings = app.getLoginItemSettings({
      path: process.execPath,
      args: []
    });
    return {
      supported: true,
      enabled: Boolean(settings.openAtLogin && settings.executableWillLaunchAtLogin),
      error: null
    };
  } catch (error) {
    return { supported: true, enabled: false, error: error.message };
  }
}

function setAutoStart(enabled) {
  if (process.platform !== "win32") return getAutoStartStatus();

  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: [],
      name: appId
    });
    const status = getAutoStartStatus();
    if (!status.error && status.enabled !== Boolean(enabled)) {
      return { ...status, error: "Windows 未能保存开机自启设置" };
    }
    return status;
  } catch (error) {
    const status = getAutoStartStatus();
    return { ...status, error: error.message };
  }
}

function encodeFilePath(rest) {
  // 逐段编码：空格/中文/#/? 等转义，保留 / 分隔
  return rest.split("/").map(seg => (seg ? encodeURIComponent(seg) : "")).join("/");
}

// 本地路径 → file:// URL。支持 d:/x、D:\x、\\srv\share\...、/unix/path、file:// 原样。
// 返回 null 表示不是本地路径（交回 http/https 逻辑）。
function localPathToFileUrl(value) {
  const text = String(value || "").trim();
  if (/^file:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      // 修正 file://d:/x（少了一根斜杠）为 file:///d:/x
      if (/^[a-zA-Z]$/.test(u.host)) return `file:///${u.host}:${u.pathname}`;
      return u.href;
    } catch { return null; }
  }
  const p = text.replace(/\\/g, "/");
  let m = p.match(/^([a-zA-Z]):\/(.*)$/); // Windows 盘符路径
  if (m) return `file:///${m[1]}:/${encodeFilePath(m[2])}`;
  m = p.match(/^\/\/([^/]+)\/(.*)$/); // UNC 网络路径 \\server\share
  if (m) return `file://${m[1]}/${encodeFilePath(m[2])}`;
  if (p.startsWith("/")) return `file:///${encodeFilePath(p.slice(1))}`; // Unix 绝对路径
  return null;
}

function normalizeTabUrl(value) {
  const text = String(value || "").trim();
  const fileUrl = localPathToFileUrl(text);
  if (fileUrl) return fileUrl;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeTabAlias(value) {
  return String(value || "").trim().slice(0, 100);
}

function normalizeShortcut(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const aliases = { CONTROL: "Ctrl", CTRL: "Ctrl", ALT: "Alt", SHIFT: "Shift", META: "Meta", CMD: "Meta", COMMAND: "Meta" };
  const modifiers = new Set();
  let key = "";
  for (const rawPart of text.split("+").map(part => part.trim()).filter(Boolean)) {
    const upper = rawPart.toUpperCase();
    if (aliases[upper]) { modifiers.add(aliases[upper]); continue; }
    if (key) return "";
    if (/^F(?:[1-9]|1[0-2])$/.test(upper)) key = upper;
    else if (/^[A-Z0-9]$/.test(upper)) key = upper;
    else return "";
  }
  if (!key) return "";
  return ["Ctrl", "Alt", "Shift", "Meta"].filter(item => modifiers.has(item)).concat(key).join("+");
}

function shortcutFromInput(input) {
  const keyName = String(input.key || "");
  if (["Control", "Alt", "Shift", "Meta"].includes(keyName)) return "";
  const key = /^F(?:[1-9]|1[0-2])$/i.test(keyName) ? keyName.toUpperCase() : (/^[a-z0-9]$/i.test(keyName) ? keyName.toUpperCase() : "");
  if (!key) return "";
  return normalizeShortcut([input.control ? "Ctrl" : "", input.alt ? "Alt" : "", input.shift ? "Shift" : "", input.meta ? "Meta" : "", key].filter(Boolean).join("+"));
}

function normalizeUrlShortcuts(urls, shortcuts) {
  const clean = {};
  const source = shortcuts && typeof shortcuts === "object" && !Array.isArray(shortcuts) ? shortcuts : {};
  urls.forEach((url, index) => {
    const configured = Object.prototype.hasOwnProperty.call(source, url) ? source[url] : (DEFAULT_URL_SHORTCUTS[index] || "");
    const shortcut = normalizeShortcut(configured);
    if (shortcut) clean[url] = shortcut;
  });
  return clean;
}

function validateUrlShortcuts(urls, shortcuts) {
  const errors = [];
  const warnings = [];
  const owners = new Map();
  for (const url of urls) {
    const raw = shortcuts?.[url];
    if (!raw) continue;
    const shortcut = normalizeShortcut(raw);
    if (!shortcut) { errors.push(`${url} 的快捷键格式不正确`); continue; }
    if (RESERVED_SHORTCUTS.has(shortcut)) errors.push(`${shortcut}：${RESERVED_SHORTCUTS.get(shortcut)}`);
    if (owners.has(shortcut)) errors.push(`${shortcut} 同时分配给了两个网址`);
    else owners.set(shortcut, url);
    if (SHORTCUT_WARNINGS.has(shortcut)) warnings.push(`${shortcut}：${SHORTCUT_WARNINGS.get(shortcut)}`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

function getAliasForUrl(url, settings = loadAppSettings()) {
  const normalizedUrl = normalizeTabUrl(url);
  return normalizedUrl ? normalizeTabAlias(settings.aliases?.[normalizedUrl]) : "";
}

function getTabStatePath() {
  return path.join(app.getPath("userData"), "tabs.json");
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function getAppSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function migrateLegacyTabSettings() {
  const settingsPath = getAppSettingsPath();
  if (fs.existsSync(settingsPath)) return null;
  try {
    const legacy = JSON.parse(fs.readFileSync(getTabStatePath(), "utf8"));
    const urls = Array.isArray(legacy.tabs)
      ? [...new Set(legacy.tabs.map(normalizeTabUrl).filter(Boolean))].slice(0, 100)
      : [];
    if (urls.length === 0) return null;
    const activeIndex = Number.isInteger(legacy.activeIndex)
      ? Math.min(Math.max(legacy.activeIndex, 0), urls.length - 1)
      : 0;
    const migrated = {
      version: 1,
      migratedFrom: "tabs.json",
      microphone: true,
      camera: false,
      defaultUrl: urls[activeIndex],
      urls,
      aliases: {},
      shortcuts: normalizeUrlShortcuts(urls, {})
    };
    fs.writeFileSync(settingsPath, JSON.stringify(migrated, null, 2), "utf8");
    console.log(`Migrated ${urls.length} URL(s) from tabs.json to settings.json`);
    return migrated;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Failed to migrate legacy tabs:", error);
    return null;
  }
}

function loadAppSettings() {
  // 无历史配置时只生成空模板；首次打开由用户在“+”中新建网址。
  const fallback = { microphone: true, camera: false, defaultUrl: "", urls: [], aliases: {}, shortcuts: {}, theme: "dark" };
  migrateLegacyTabSettings();
  try {
    const state = JSON.parse(fs.readFileSync(getAppSettingsPath(), "utf8"));
    const urls = Array.isArray(state.urls)
      ? [...new Set(state.urls.map(normalizeTabUrl).filter(Boolean))].slice(0, 100)
      : [];
    const requestedDefault = normalizeTabUrl(state.defaultUrl);
    const aliases = {};
    if (state.aliases && typeof state.aliases === "object" && !Array.isArray(state.aliases)) {
      for (const url of urls) {
        const alias = normalizeTabAlias(state.aliases[url]);
        if (alias) aliases[url] = alias;
      }
    }
    return {
      microphone: state.microphone !== false,
      camera: state.camera === true,
      defaultUrl: requestedDefault && urls.includes(requestedDefault) ? requestedDefault : urls[0] || "",
      urls,
      aliases,
      shortcuts: normalizeUrlShortcuts(urls, state.shortcuts),
      theme: state.theme === "light" ? "light" : "dark"
    };
  } catch {
    // 首次运行持久化模板；若已有文件但内容损坏，保留原文件以免无提示覆盖用户数据。
    const settingsPath = getAppSettingsPath();
    if (!fs.existsSync(settingsPath)) {
      try {
        fs.writeFileSync(settingsPath, JSON.stringify({ version: 2, ...fallback }, null, 2), "utf8");
      } catch (error) {
        console.error("Failed to create default settings template:", error);
      }
    }
    return fallback;
  }
}

function saveAppSettings(settings) {
  const urls = [...new Set((settings.urls || []).map(normalizeTabUrl).filter(Boolean))].slice(0, 100);
  if (urls.length === 0) {
    // 允许清空所有网址：写入空列表，下次启动进入空白引导状态
    const empty = {
      version: 2,
      microphone: settings.microphone !== false,
      camera: settings.camera === true,
      defaultUrl: "",
      urls: [],
      aliases: {},
      shortcuts: {},
      theme: settings.theme === "light" ? "light" : "dark"
    };
    fs.writeFileSync(getAppSettingsPath(), JSON.stringify(empty, null, 2), "utf8");
    syncTabbar();
    setupApplicationMenu();
    return empty;
  }
  const requestedDefault = normalizeTabUrl(settings.defaultUrl);
  const aliases = {};
  if (settings.aliases && typeof settings.aliases === "object" && !Array.isArray(settings.aliases)) {
    for (const url of urls) {
      const alias = normalizeTabAlias(settings.aliases[url]);
      if (alias) aliases[url] = alias;
    }
  }
  const shortcutValidation = validateUrlShortcuts(urls, settings.shortcuts || {});
  if (!shortcutValidation.valid) throw new Error(shortcutValidation.errors.join("；"));
  const shortcuts = normalizeUrlShortcuts(urls, settings.shortcuts);
  const clean = {
    version: 2,
    microphone: settings.microphone !== false,
    camera: settings.camera === true,
    defaultUrl: requestedDefault && urls.includes(requestedDefault) ? requestedDefault : urls[0],
    urls,
    aliases,
    shortcuts,
    theme: settings.theme === "light" ? "light" : "dark"
  };
  fs.writeFileSync(getAppSettingsPath(), JSON.stringify(clean, null, 2), "utf8");
  for (const entry of views) {
    // 配置中的别名以标签最初打开的入口 URL 为键；登录回调/重定向后的实际 URL
    // 只是恢复和重建用途，不能导致用户刚保存的重命名丢失。
    entry.alias = getAliasForUrl(entry.sourceUrl || entry.url, clean) || getAliasForUrl(entry.url, clean);
    entry.title = entry.alias || entry.pageTitle || entry.url;
  }
  syncTabbar();
  setupApplicationMenu();
  return clean;
}

function updatePermissionSetting(key, enabled) {
  const settings = loadAppSettings();
  settings[key] = Boolean(enabled);
  saveAppSettings(settings);
}

// ── 主题（深色/浅色）──────────────────────────────────────

function applyTheme(theme) {
  currentTheme = theme === "light" ? "light" : "dark";
  const bg = themeColors[currentTheme];

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(bg);
  }
  if (tabbarView && !tabbarView.webContents.isDestroyed()) {
    tabbarView.setBackgroundColor(bg);
    tabbarView.webContents.send("theme:update", currentTheme);
  }
  for (const entry of views) {
    if (!entry.view.webContents.isDestroyed()) entry.view.setBackgroundColor(bg);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("theme:update", currentTheme);
  }
  setupApplicationMenu();
}

function setTheme(theme) {
  const settings = loadAppSettings();
  settings.theme = theme === "light" ? "light" : "dark";
  saveAppSettings(settings);
  applyTheme(settings.theme);
  return settings.theme;
}

ipcMain.handle("theme:set", (_event, theme) => setTheme(theme));
ipcMain.handle("theme:get", () => currentTheme);

function showUrlManager() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    title: "网址与快捷键管理",
    width: 1080,
    height: 560,
    minWidth: 900,
    minHeight: 480,
    autoHideMenuBar: true,
    icon: iconPath,
    backgroundColor: themeColors[currentTheme],
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

function loadWindowState() {
  const fallback = { width: 1280, height: 800, isMaximized: false };
  try {
    const state = JSON.parse(fs.readFileSync(getWindowStatePath(), "utf8"));
    const bounds = {
      x: Number.isInteger(state.x) ? state.x : undefined,
      y: Number.isInteger(state.y) ? state.y : undefined,
      width: Number.isInteger(state.width) ? Math.max(state.width, 900) : fallback.width,
      height: Number.isInteger(state.height) ? Math.max(state.height, 600) : fallback.height
    };
    const visible = screen.getAllDisplays().some(display => {
      const area = display.workArea;
      return bounds.x !== undefined && bounds.y !== undefined &&
        bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    });
    if (!visible) {
      delete bounds.x;
      delete bounds.y;
    }
    return { ...bounds, isMaximized: Boolean(state.isMaximized) };
  } catch {
    return fallback;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  try {
    fs.writeFileSync(getWindowStatePath(), JSON.stringify({
      version: 1,
      ...bounds,
      isMaximized: mainWindow.isMaximized()
    }, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save window state:", error);
  }
}

function setupApplicationMenu() {
  const settings = loadAppSettings();
  const autoStart = getAutoStartStatus();
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "新建标签页", accelerator: "CmdOrCtrl+T", click: () => promptForNewTab() },
        { type: "separator" },
        { label: "刷新当前页面", accelerator: "F5", click: () => reloadActiveView() },
        { label: "强制刷新当前页面", accelerator: "CmdOrCtrl+Shift+R", click: () => reloadActiveView(true) },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "设置",
      submenu: [
        {
          label: "允许麦克风",
          type: "checkbox",
          checked: settings.microphone,
          click: item => updatePermissionSetting("microphone", item.checked)
        },
        {
          label: "允许摄像头",
          type: "checkbox",
          checked: settings.camera,
          click: item => updatePermissionSetting("camera", item.checked)
        },
        { type: "separator" },
        {
          label: "深色模式",
          type: "radio",
          checked: settings.theme !== "light",
          click: () => setTheme("dark")
        },
        {
          label: "浅色模式",
          type: "radio",
          checked: settings.theme === "light",
          click: () => setTheme("light")
        },
        { type: "separator" },
        {
          label: "开机自启",
          type: "checkbox",
          checked: autoStart.enabled,
          enabled: autoStart.supported,
          click: item => {
            const status = setAutoStart(item.checked);
            if (status.error) dialog.showErrorBox("开机自启设置失败", status.error);
            setupApplicationMenu();
          }
        }
      ]
    },
    {
      label: "网址",
      submenu: [
        ...settings.urls.map(url => ({
          label: `${url === settings.defaultUrl ? "✓ " : ""}${getAliasForUrl(url, settings) || url}`,
          click: () => newTab(url)
        })),
        { type: "separator" },
        { label: "管理网址与快捷键...", click: showUrlManager }
      ]
    },
    {
      label: "帮助",
      submenu: [
        { label: `当前版本 ${app.getVersion()}`, enabled: false },
        { label: updateReadyToInstall ? "安装已下载的更新" : "检查更新...", click: () => updateReadyToInstall ? autoUpdater.quitAndInstall(false, true) : checkForUpdates(true) },
        {
          label: "关于工作台",
          click: () => dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "关于工作台",
            message: "工作台 Workbench",
            detail: `作者：swlrx\n版本：${app.getVersion()}\nElectron：${process.versions.electron}\nChromium：${process.versions.chrome}`,
            buttons: ["确定"],
            icon: iconPath
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateErrorMessage(error) {
  return String(error?.message || error || "未知错误").slice(0, 1000);
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", async info => {
    updateCheckRunning = false;
    updateCheckInteractive = false;
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "发现新版本",
      message: `发现工作台 ${info.version}`,
      detail: `当前版本：${app.getVersion()}\n最新版本：${info.version}\n\n是否立即下载更新？`,
      buttons: ["下载更新", "稍后"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (result.response !== 0 || updateDownloadRunning) return;
    updateDownloadRunning = true;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      updateDownloadRunning = false;
      dialog.showErrorBox("更新下载失败", updateErrorMessage(error));
    }
  });

  autoUpdater.on("update-not-available", () => {
    updateCheckRunning = false;
    const shouldNotify = updateCheckInteractive;
    updateCheckInteractive = false;
    if (shouldNotify && mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, {
      type: "info", title: "检查更新", message: "当前已是最新版本", buttons: ["确定"]
    });
  });

  autoUpdater.on("download-progress", progress => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    mainWindow.setProgressBar(percent / 100);
  });

  autoUpdater.on("update-downloaded", async info => {
    updateDownloadRunning = false;
    updateReadyToInstall = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
    setupApplicationMenu();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "更新已下载",
      message: `工作台 ${info.version} 已下载完成`,
      detail: "是否立即退出并安装更新？",
      buttons: ["立即安装", "稍后"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on("error", error => {
    const wasActive = updateCheckRunning || updateDownloadRunning;
    const shouldNotify = updateCheckInteractive || updateDownloadRunning;
    updateCheckRunning = false;
    updateDownloadRunning = false;
    updateCheckInteractive = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
    if (wasActive && shouldNotify) dialog.showErrorBox("检查更新失败", updateErrorMessage(error));
  });
}

async function checkForUpdates(showNoUpdate = false) {
  if (updateCheckRunning || updateDownloadRunning) return;
  if (!app.isPackaged) {
    if (showNoUpdate) dialog.showMessageBox(mainWindow, {
      type: "info", title: "检查更新", message: "开发模式不执行自动更新", buttons: ["确定"]
    });
    return;
  }
  updateCheckRunning = true;
  updateCheckInteractive = showNoUpdate;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    if (!updateCheckRunning) return;
    updateCheckRunning = false;
    const shouldNotify = updateCheckInteractive;
    updateCheckInteractive = false;
    if (shouldNotify) dialog.showErrorBox("检查更新失败", updateErrorMessage(error));
  }
}

function isAllowedMediaRequest(permission, details = {}) {
  if (permission !== "media") return false;
  const settings = loadAppSettings();
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  if (mediaTypes.includes("audio") && !settings.microphone) return false;
  if (mediaTypes.includes("video") && !settings.camera) return false;
  if (mediaTypes.length === 0) return settings.microphone || settings.camera;
  return true;
}

function isAllowedMediaCheck(permission, details = {}) {
  if (permission !== "media") return false;
  const settings = loadAppSettings();
  if (details.mediaType === "audio") return settings.microphone;
  if (details.mediaType === "video") return settings.camera;
  return settings.microphone || settings.camera;
}

function showContentContextMenu(view, params) {
  const menu = Menu.buildFromTemplate([
    { label: "后退", enabled: view.webContents.canGoBack(), click: () => view.webContents.goBack() },
    { label: "前进", enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() },
    { type: "separator" },
    { label: "重新加载", click: () => view.webContents.reload() },
    { label: "强制重新加载", click: () => view.webContents.reloadIgnoringCache() },
    { type: "separator" },
    { role: "copy", label: "复制", enabled: Boolean(params.selectionText) },
    { role: "paste", label: "粘贴", enabled: params.isEditable },
    { label: "在浏览器中打开", click: () => shell.openExternal(view.webContents.getURL()) }
  ]);
  menu.popup({ window: mainWindow });
}

function loadTabState() {
  try {
    const state = JSON.parse(fs.readFileSync(getTabStatePath(), "utf8"));
    const urls = Array.isArray(state.tabs)
      ? state.tabs.map(normalizeTabUrl).filter(Boolean).slice(0, 100)
      : [];
    const requestedIndex = Number.isInteger(state.activeIndex) ? state.activeIndex : 0;
    const activeIndex = urls.length > 0
      ? Math.min(Math.max(requestedIndex, 0), urls.length - 1)
      : 0;
    return { urls, activeIndex };
  } catch {
    return { urls: [], activeIndex: 0 };
  }
}

function saveTabState() {
  if (!app.isReady()) return;
  const tabs = views
    .map(v => ({ id: v.id, url: normalizeTabUrl(v.url) }))
    .filter(v => v.url);

  const activeIndex = tabs.length > 0 ? Math.max(0, tabs.findIndex(v => v.id === activeId)) : 0;
  try {
    fs.writeFileSync(getTabStatePath(), JSON.stringify({
      version: 1,
      tabs: tabs.map(v => v.url),
      activeIndex
    }, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save tabs:", error);
  }
}

async function flushSessionData() {
  if (sessionDataFlushed || !app.isReady()) return;
  sessionDataFlushed = true;
  try {
    await session.defaultSession.flushStorageData();
  } catch (error) {
    sessionDataFlushed = false;
    console.error("Failed to flush session data:", error);
  }
}

function restoreTabs() {
  if (views.length > 0) return;
  const state = loadTabState();
  const settings = loadAppSettings();
  let urls = state.urls.length > 0 ? state.urls : (settings.urls.length > 0 ? [settings.defaultUrl] : []);

  // 没有保存的标签和网址时保持空白，显示“+”让用户主动新建；不再注入默认入口。
  if (urls.length === 0) {
    activeId = null;
    layoutViews();
    syncTabbar();
    promptForNewTab();
    return;
  }

  // 先创建全部标签占位（tabbar 完整显示），内容按队列串行加载
  for (const url of urls) {
    views.push(createView(url, { deferLoad: true }));
  }
  activeId = views[Math.min(state.activeIndex, views.length - 1)].id;
  layoutViews();
  syncTabbar();
  saveTabState();

  // 串行加载：激活标签最先，其余按原顺序，避免并发拖慢后端
  const queue = [views.find(v => v.id === activeId), ...views.filter(v => v.id !== activeId)];
  loadTabQueue(queue);
}

function loadTabQueue(queue) {
  const entry = queue.shift();
  if (!entry) return;
  if (entry.view.webContents.isDestroyed() || !entry.pendingLoad) {
    loadTabQueue(queue);
    return;
  }

  entry.pendingLoad = false;
  entry.loadStartedAt = Date.now();
  if (process.env.HERMES_DEBUG_LOAD === "1") {
    console.log(`[load-queue] start ${entry.url}`);
  }

  let advanced = false;
  const next = () => {
    if (advanced) return;
    advanced = true;
    clearTimeout(timer);
    if (process.env.HERMES_DEBUG_LOAD === "1") {
      console.log(`[load-queue] done  ${entry.url} in ${Date.now() - entry.loadStartedAt}ms`);
    }
    loadTabQueue(queue);
  };
  // 单标签最多等 20s，防止某个无响应标签卡死整个队列
  const timer = setTimeout(next, 20000);

  entry.view.webContents.once("did-finish-load", next);
  entry.view.webContents.once("did-fail-load", next);
  entry.view.webContents.once("render-process-gone", next);
  entry.view.webContents.loadURL(entry.url).catch(next);
}

function promptForNewTab() {
  // 在 tabbar 的 "+" 按钮位置弹出新建标签输入框（复用现有交互）
  if (tabbarView && !tabbarView.webContents.isDestroyed()) {
    tabbarView.webContents.send("tab:prompt-new");
  }
}

function reloadActiveView(ignoreCache = false) {
  const entry = views.find(v => v.id === activeId);
  if (!entry || entry.view.webContents.isDestroyed()) return;
  if (ignoreCache) entry.view.webContents.reloadIgnoringCache();
  else entry.view.webContents.reload();
}

function clearRecoveryTimers(entry) {
  if (!entry) return;
  if (entry.recoveryReloadTimer) clearTimeout(entry.recoveryReloadTimer);
  if (entry.recoveryRebuildTimer) clearTimeout(entry.recoveryRebuildTimer);
  entry.recoveryReloadTimer = null;
  entry.recoveryRebuildTimer = null;
  entry.recovering = false;
}

function rebuildTabView(id, reason) {
  const index = views.findIndex(entry => entry.id === id);
  if (index < 0) return;
  const entry = views[index];
  clearRecoveryTimers(entry);
  const oldView = entry.view;
  try { mainWindow.contentView.removeChildView(oldView); } catch {}
  if (!oldView.webContents.isDestroyed()) oldView.webContents.destroy();

  // 只重建失效标签，保留 URL、标签 ID 与 defaultSession 的 cookie/登录状态。
  const replacement = createView(entry.url, { id });
  views[index] = {
    ...entry,
    ...replacement,
    sourceUrl: entry.sourceUrl || entry.url,
    recovering: false,
    recoveryReloadTimer: null,
    recoveryRebuildTimer: null
  };
  console.error(`Rebuilt unresponsive tab (${reason}): ${entry.url}`);
  layoutViews();
  syncTabbar();
}

function recoverTabView(id, sourceView, reason) {
  const entry = views.find(item => item.id === id && item.view === sourceView);
  if (!entry || entry.recovering || sourceView.webContents.isDestroyed()) return;
  entry.recovering = true;
  console.error(`Recovering unresponsive tab (${reason}): ${entry.url}`);

  // 给短暂 GC/网络抖动一次恢复机会；无响应持续则重建该标签，不影响其他标签和主窗口。
  entry.recoveryReloadTimer = setTimeout(() => {
    const current = views.find(item => item.id === id && item.view === sourceView);
    if (!current || sourceView.webContents.isDestroyed()) return;
    sourceView.webContents.reloadIgnoringCache();
  }, 1500);
  entry.recoveryRebuildTimer = setTimeout(() => {
    const current = views.find(item => item.id === id && item.view === sourceView);
    if (current && current.recovering) rebuildTabView(id, reason);
  }, 12000);
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: title || appTitle, body: body || "", icon: iconPath, silent: false });
  n.on("click", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  n.show();
  return true;
}

ipcMain.handle("hermes:notify", (_event, payload) => {
  const p = payload || {};
  return showNotification(p.title || appTitle, p.body || "");
});

ipcMain.handle("link:open-external", async (_event, value) => {
  const url = normalizeTabUrl(value);
  if (!url) return false;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "打开链接",
    message: "是否使用默认浏览器打开以下链接？",
    detail: url,
    buttons: ["使用默认浏览器打开", "关闭"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (result.response !== 0) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("autostart:get", () => getAutoStartStatus());
ipcMain.handle("autostart:set", (_event, enabled) => setAutoStart(enabled));
ipcMain.handle("settings:get", () => loadAppSettings());
ipcMain.handle("settings:save", (_event, settings) => saveAppSettings(settings || {}));
ipcMain.handle("shortcuts:validate", (_event, settings) => {
  const urls = Array.isArray(settings?.urls) ? settings.urls.map(normalizeTabUrl).filter(Boolean) : [];
  return validateUrlShortcuts(urls, settings?.shortcuts || {});
});

// Tab IPC
ipcMain.on("tab:new", (_event, url) => newTab(url));
ipcMain.on("tab:switch", (_event, id) => switchTab(id));
ipcMain.on("tab:close", (_event, id) => closeTab(id));

ipcMain.on("tab:move", (_event, dragId, targetId, after) => moveTab(dragId, targetId, after));

// 拖拽排序：把 dragId 标签移动到 targetId 的前/后，并持久化
function moveTab(dragId, targetId, after) {
  const from = views.findIndex(v => v.id === dragId);
  const to = views.findIndex(v => v.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = views.splice(from, 1);
  let insertAt = views.findIndex(v => v.id === targetId);
  if (after) insertAt += 1;
  views.splice(insertAt, 0, moved);
  layoutViews();   // BrowserView 的 z-order/位置与 views 顺序无关，但保持调用以防未来依赖
  syncTabbar();
  saveTabState();
}

function syncTabbar() {
  if (!tabbarView) return;
  const tabs = views.map(v => ({ id: v.id, title: v.title }));
  tabbarView.webContents.send("tab:update", { tabs, activeId });
}

// ── 内容 View ─────────────────────────────────────────────

function resolveDownloadFilename(item) {
  // 1. 正常的 Content-Disposition 文件名
  const nativeName = path.basename(item.getFilename() || "");
  if (nativeName && nativeName !== "download" && path.extname(nativeName)) {
    return nativeName;
  }

  // 2. Hermes /api/hermes/download?name=... 或 path=... 的原始文件名
  try {
    const downloadUrl = new URL(item.getURL());
    const requestedName = downloadUrl.searchParams.get("name");
    const sourcePath = downloadUrl.searchParams.get("path");
    const nameFromUrl = requestedName || (sourcePath ? path.basename(sourcePath) : "");
    if (nameFromUrl) return path.basename(nameFromUrl);
  } catch {
    // 非 URL 或解析失败则使用 Electron 提供的名称
  }

  // 3. 最后才使用 Electron 文件名；无法判定时仍保留默认名
  return nativeName || "download";
}

function setupDownloadHandling() {
  if (downloadHandlingReady) return;
  downloadHandlingReady = true;

  session.defaultSession.on("will-download", (_event, item) => {
    // Electron 在 will-download 返回时尚未设置保存路径会自行弹出保存窗口；
    // 因此不能在这里异步等待 showSaveDialog，否则会出现两层目录确认弹窗。
    // 使用单个原生同步保存框，监听器返回前完成 setSavePath，确保只弹一次。
    const filename = resolveDownloadFilename(item);
    const defaultPath = path.join(app.getPath("downloads"), filename);
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      title: "保存下载文件", defaultPath, buttonLabel: "保存",
      properties: ["showOverwriteConfirmation"]
    });
    if (!savePath) {
      item.cancel();
      return;
    }
    item.setSavePath(savePath);
    item.once("done", (_doneEvent, state) => {
      if (state === "completed") {
        showNotification(appTitle, "下载完成：" + path.basename(savePath));
        mainWindow.focus();
      } else if (state !== "cancelled") {
        dialog.showErrorBox("下载失败", "文件未能完成下载：" + path.basename(savePath));
      }
    });
  });
}

function openUrlShortcut(url) {
  const normalizedUrl = normalizeTabUrl(url);
  if (!normalizedUrl) return;
  const existing = views.find(entry => normalizeTabUrl(entry.sourceUrl) === normalizedUrl || normalizeTabUrl(entry.url) === normalizedUrl);
  if (existing) switchTab(existing.id);
  else newTab(normalizedUrl);
}

function attachViewInputShortcuts(webContents) {
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const shortcut = shortcutFromInput(input);
    if (!shortcut) return;
    if (["F5", "Ctrl+F5", "Shift+F5", "Ctrl+Shift+R"].includes(shortcut)) {
      event.preventDefault();
      if (shortcut !== "F5") webContents.reloadIgnoringCache();
      else webContents.reload();
      return;
    }
    const settings = loadAppSettings();
    const target = settings.urls.find(url => settings.shortcuts?.[url] === shortcut);
    if (!target) return;
    event.preventDefault();
    if (!input.isAutoRepeat) openUrlShortcut(target);
  });
}

function createView(url, options = {}) {
  const id = Number.isInteger(options.id) ? options.id : nextId++;
  const alias = getAliasForUrl(url);
  const view = new WebContentsView({
    backgroundColor: themeColors[currentTheme], // 主题色兜底：加载期/缩放取整时未覆盖区域不露白
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false
    }
  });

  view.webContents.session.setCertificateVerifyProc((request, callback) => {
    callback(certHosts.includes(request.hostname) ? 0 : -3);
  });

  // 登录站点常将身份验证页放在另一域名，甚至用 window.open() 创建弹窗。
  // 这些页面必须留在 Electron 的持久化 session 中，认证 cookie/回调才会回到
  // 工作台内的原标签；交给系统浏览器会落在另一份 cookie 存储中，导致客户端仍未登录。
  view.webContents.setWindowOpenHandler(({ url: u }) => {
    const popupUrl = normalizeTabUrl(u);
    if (popupUrl) {
      // Electron 需要同步返回处理方式；在下一轮事件循环中新建应用内标签，避免
      // 给站点创建无主 BrowserWindow，同时保留同一个 defaultSession。
      queueMicrotask(() => newTab(popupUrl));
    }
    return { action: "deny" };
  });
  // 跨域跳转（例如业务站点 → 统一登录 → 回调地址）在当前内置页面继续，
  // 不得调用 shell.openExternal，否则登录会脱离本客户端的会话。
  view.webContents.on("will-navigate", (_event, _u) => {});

  // F5/强刷快捷键在内容视图获得焦点时也必须生效。
  attachViewInputShortcuts(view.webContents);

  view.webContents.on("dom-ready", () => {
    injectNativeNotificationBridge(view.webContents);
  });

  view.webContents.on("context-menu", (_event, params) => {
    showContentContextMenu(view, params);
  });

  view.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone for ${view.webContents.getURL()}:`, details);
    rebuildTabView(id, `renderer-${details.reason || "gone"}`);
  });

  view.webContents.on("unresponsive", () => {
    recoverTabView(id, view, "unresponsive");
  });
  view.webContents.on("responsive", () => {
    const entry = views.find(item => item.id === id && item.view === view);
    clearRecoveryTimers(entry);
  });

  view.webContents.on("did-finish-load", () => {
    const entry = views.find(item => item.id === id && item.view === view);
    clearRecoveryTimers(entry);
  });
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      console.error(`Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
    }
  });

  view.webContents.on("did-navigate", (_event, navigatedUrl) => {
    const entry = views.find(item => item.id === id && item.view === view);
    if (!entry) return;
    const normalizedUrl = normalizeTabUrl(navigatedUrl);
    if (!normalizedUrl) return;

    // 别名是用户在“网址管理”中按配置入口 URL 设置的。统一登录、反向代理和
    // 首页重定向常使实际 URL 变化；若无条件用新 URL 查别名，会把已设置的
    // 标签重命名立即覆盖成网页标题，看起来像“重命名失效”。
    // 有用户别名时保留配置入口作为稳定键；未命名标签才记录实际导航 URL，
    // 供崩溃重建和恢复标签时回到最后页面。
    if (entry.alias) return;
    entry.url = normalizedUrl;
    entry.alias = getAliasForUrl(normalizedUrl);
    entry.title = entry.alias || entry.pageTitle || normalizedUrl;
    saveTabState();
    syncTabbar();
  });

  view.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    const idx = views.findIndex(v => v.id === id);
    if (idx >= 0) {
      views[idx].pageTitle = view.webContents.getTitle() || url;
      views[idx].title = views[idx].alias || views[idx].pageTitle;
      syncTabbar();
    }
  });

  if (options.deferLoad) {
    // 启动队列：占位创建，不立即加载（pendingLoad 标记由 loadTabQueue 消费）
    return { id, view, url, sourceUrl: url, alias, pageTitle: url, title: alias || url, pendingLoad: true };
  }

  view.webContents.loadURL(url);
  return { id, view, url, sourceUrl: url, alias, pageTitle: url, title: alias || url };
}

function newTab(url) {
  const normalizedUrl = normalizeTabUrl(url);
  if (!normalizedUrl) return;
  const entry = createView(normalizedUrl);
  views.push(entry);
  activeId = entry.id;
  layoutViews();
  syncTabbar();
  saveTabState();
}

function switchTab(id) {
  if (!views.some(v => v.id === id)) return;
  activeId = id;
  // 用户切到尚未轮到的标签：立即插队加载，不等队列
  const entry = views.find(v => v.id === id);
  if (entry && entry.pendingLoad) loadTabQueue([entry]);
  layoutViews();
  syncTabbar();
  saveTabState();
}

function closeTab(id) {
  const idx = views.findIndex(v => v.id === id);
  if (idx < 0) return;
  const entry = views[idx];
  clearRecoveryTimers(entry);
  mainWindow.contentView.removeChildView(entry.view);
  entry.view.webContents.destroy();
  views.splice(idx, 1);
  if (views.length === 0) {
    // 不再回落预存默认网址：保存空状态并引导新建
    saveTabState();
    promptForNewTab();
    return;
  }
  if (activeId === id) activeId = views[Math.min(idx, views.length - 1)].id;
  layoutViews();
  syncTabbar();
  saveTabState();
}

// ── 布局 ──────────────────────────────────────────────────

function layoutViews() {
  if (!mainWindow) return;
  const [winW, winH] = mainWindow.getContentSize();

  // WebContentsView 是 Electron 30+ 的 BrowserView 替代品；不再依赖已废弃的
  // BrowserView 附着/移除 API，减少多标签的焦点和层级异常。
  if (tabbarView) {
    tabbarView.setBounds({ x: 0, y: 0, width: winW, height: TABBAR_H });
  }

  // 内容区在 tabbar 下面；每次先移除后添加活动页，使 tabbar 始终置顶。
  const contentY = TABBAR_H;
  const contentH = winH - TABBAR_H;
  for (const v of views) {
    mainWindow.contentView.removeChildView(v.view);
  }
  const active = views.find(v => v.id === activeId);
  if (active) {
    active.view.setBounds({ x: 0, y: contentY, width: winW, height: contentH });
    mainWindow.contentView.addChildView(active.view);
  }
  if (tabbarView) mainWindow.contentView.addChildView(tabbarView);
}

// ── 主窗口 ────────────────────────────────────────────────

function createWindow() {
  const windowState = loadWindowState();
  mainWindow = new BrowserWindow({
    title: appTitle,
    icon: iconPath,
    backgroundColor: themeColors[currentTheme], // 主题色兜底：任何 BrowserView 未覆盖区域不露白
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 900, minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false }
  });

  // 默认隐藏菜单栏；由 Electron 原生 Alt 处理显示与焦点，避免自行拦截 Alt 后
  // 出现“必须按住才能看见、无法点击”的状态。
  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);
  if (windowState.isMaximized) mainWindow.maximize();

  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow.setTitle(appTitle);
  });

  mainWindow.on("resize", () => layoutViews());
  mainWindow.on("close", () => {
    saveWindowState();
    saveTabState();
    flushSessionData();
  });

  // 所有内容标签共用 defaultSession，下载监听只能注册一次。
  setupDownloadHandling();

  // tabbar 使用同一套 WebContentsView 容器，避免旧 BrowserView 的焦点/层级问题。
  tabbarView = new WebContentsView({
    backgroundColor: themeColors[currentTheme],
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    }
  });
  attachViewInputShortcuts(tabbarView.webContents);
  mainWindow.contentView.addChildView(tabbarView);
  tabbarView.webContents.loadFile(path.join(__dirname, "tabbar.html"));

  tabbarView.webContents.on("did-finish-load", () => {
    restoreTabs();
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === "notifications" || isAllowedMediaRequest(permission, details));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    return permission === "notifications" || isAllowedMediaCheck(permission, details);
  });
}

app.whenReady().then(async () => {
  app.setName(appTitle);
  currentTheme = loadAppSettings().theme === "light" ? "light" : "dark";
  setupAutoUpdater();
  setupApplicationMenu();
  createWindow();
  setTimeout(() => checkForUpdates(false), 3000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  saveTabState();
  flushSessionData();
});
