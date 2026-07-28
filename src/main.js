import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  session,
  shell,
  ipcMain,
  nativeImage,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(__dirname, "..", "build");

const CHAT_URL = "https://chat.google.com/";

// Electron ships unbranded Chromium, so both the legacy UA string and the
// Client Hints (Sec-CH-UA*) headers/APIs report brands like "Chromium" with
// no "Google Chrome" entry. Google's sign-in flow reads those brands and
// silently bounces unrecognized browsers to a marketing page instead of the
// real app, so both surfaces need to claim a real Chrome build.
const CHROME_FULL_VERSION = process.versions.chrome;
const CHROME_MAJOR = CHROME_FULL_VERSION.split(".")[0];
const CHROME_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL_VERSION} Safari/537.36`;
const SEC_CH_UA = `"Not)A;Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`;
const SEC_CH_UA_FULL_VERSION_LIST = `"Not)A;Brand";v="8.0.0.0", "Chromium";v="${CHROME_FULL_VERSION}", "Google Chrome";v="${CHROME_FULL_VERSION}"`;

// Hosts Chat Wrapper legitimately needs to navigate to in-app (auth, the app
// itself, and calls). Everything else opens in the system browser instead.
const ALLOWED_HOSTS = new Set([
  "chat.google.com",
  "mail.google.com",
  "accounts.google.com",
  "myaccount.google.com",
  "meet.google.com",
  "workspace.google.com",
  "apis.google.com",
  "gds.google.com",
]);

// Hosts that land here after a successful sign-in. When an auth popup
// navigates to one of these, the shared session cookie is already valid, so
// the popup is closed and the main window is refreshed in place instead of
// leaving two windows around.
const SIGNED_IN_HOSTS = new Set(["chat.google.com", "mail.google.com"]);

app.setName("Chat Wrapper");
if (process.platform === "win32") {
  app.setAppUserModelId("com.gearboxgo.googlechat");
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

function getHostname(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

function isAllowedInApp(urlString) {
  const hostname = getHostname(urlString);
  return hostname !== null && ALLOWED_HOSTS.has(hostname);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateBadge(count) {
  if (process.platform === "darwin" || process.platform === "linux") {
    app.setBadgeCount(count || 0);
  } else if (
    process.platform === "win32" &&
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    if (count > 0) {
      mainWindow.setOverlayIcon(
        nativeImage.createFromPath(path.join(buildDir, "trayIcon.png")),
        `${count} unread`,
      );
    } else {
      mainWindow.setOverlayIcon(null, "");
    }
  }
  if (tray) {
    tray.setToolTip(
      count > 0 ? `Chat Wrapper (${count} unread)` : "Chat Wrapper",
    );
  }
}

function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowed = new Set([
        "notifications",
        "media",
        "clipboard-sanitized-write",
        "fullscreen",
      ]);
      callback(allowed.has(permission));
    },
  );
}

function setupClientHints() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    const setHeader = (name, value) => {
      const existingKey = Object.keys(headers).find(
        (k) => k.toLowerCase() === name.toLowerCase(),
      );
      headers[existingKey || name] = value;
    };
    setHeader("sec-ch-ua", SEC_CH_UA);
    setHeader("sec-ch-ua-full-version-list", SEC_CH_UA_FULL_VERSION_LIST);
    setHeader("sec-ch-ua-full-version", `"${CHROME_FULL_VERSION}"`);
    callback({ requestHeaders: headers });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 500,
    title: "Chat Wrapper",
    icon: path.join(buildDir, "icon.png"),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  // A standard Chrome UA keeps Google's sign-in flow from blocking the
  // embedded browser as an "insecure" one.
  mainWindow.webContents.setUserAgent(CHROME_USER_AGENT);

  mainWindow.loadURL(CHAT_URL);

  if (process.env.DEBUG_NAV) {
    mainWindow.webContents.on("did-navigate", (e, url) =>
      console.log("NAVIGATE:", url),
    );
    mainWindow.webContents.on("did-fail-load", (e, code, desc, url) =>
      console.log("FAIL:", code, desc, url),
    );
    mainWindow.webContents.on("console-message", (e) =>
      console.log("[renderer]", e.message),
    );
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedInApp(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Sign-in happens in a popup (window.open()), and Google's auth flow
  // expects a real popup with window.opener intact — forcing it into the
  // main window instead breaks sign-in entirely ("This browser or app may
  // not be secure"). So the popup is left alone; once it navigates to a
  // signed-in Chat/Mail URL, the session cookie (shared across the whole
  // app) is already valid, so the popup is closed and the main window is
  // brought back in sync instead of leaving two windows around.
  mainWindow.webContents.on("did-create-window", (childWindow) => {
    childWindow.webContents.on("did-navigate", (event, navigatedUrl) => {
      if (SIGNED_IN_HOSTS.has(getHostname(navigatedUrl))) {
        childWindow.close();
        showWindow();
        mainWindow.webContents.loadURL(CHAT_URL);
      }
    });
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedInApp(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("page-title-updated", (event, title) => {
    const match = title.match(/^\((\d+)\)/);
    updateBadge(match ? parseInt(match[1], 10) : 0);
  });

  // Closing the window just hides it — the renderer keeps running in the
  // background so it can keep receiving Chat notifications, like Slack.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(buildDir, "trayIcon.png"));
  tray = new Tray(icon);
  tray.setToolTip("Chat Wrapper");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Chat Wrapper", click: () => showWindow() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => showWindow());
}

ipcMain.on("notification-click", () => showWindow());

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

app.on("activate", () => showWindow());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    setupPermissions();
    setupClientHints();
    createWindow();
    createTray();
  });
}
