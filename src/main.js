import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  session,
  shell,
  ipcMain,
  nativeImage,
  Notification,
} from "electron";
import fs from "node:fs";
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

// Chat's own background-push notification path (ServiceWorkerRegistration
// .showNotification, called from its service worker) hits a longstanding
// Electron implementation gap and silently fails — see sw-preload.cjs. This
// is the reliable fallback: fire a real notification directly from the main
// process (proven to work end-to-end) instead of depending on Chat's own
// notification delivery succeeding.
//
// Chat flashes the document title between "<name> - Chat" and "<name>
// messaged you - Chat" repeatedly (every second or so) for as long as a
// message stays unread — it never settles on one value, and there's no
// numeric count. A plain cooldown just turns into a periodic reminder that
// keeps re-firing every N seconds until the message is read. Instead, treat
// a continuous run of same-sender flashes (gap under STREAK_GAP_MS) as one
// notification-worthy event: notify once at the start of a streak, then
// suppress until either the sender changes or the flashing actually stops
// (implying read) and later restarts (a genuinely new message).
const STREAK_GAP_MS = 8_000;
let streakSender = null;
let streakNotified = false;
let streakLastSeenAt = 0;

function notifyFromTitle(title) {
  const match = title.match(/^(.+) messaged you - Chat$/);
  if (!match) return;
  const sender = match[1];
  const now = Date.now();

  if (sender !== streakSender || now - streakLastSeenAt > STREAK_GAP_MS) {
    streakSender = sender;
    streakNotified = false;
  }
  streakLastSeenAt = now;

  if (
    !streakNotified &&
    Notification.isSupported() &&
    (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused())
  ) {
    const notification = new Notification({
      title: sender,
      body: "messaged you",
    });
    notification.on("click", () => {
      showWindow();
      navigateToConversation(sender);
    });
    notification.show();
    streakNotified = true;
  }
}

// Best-effort: click a sidebar conversation row matching the sender's name.
// Chat's row markup uses auto-generated, frequently-changing CSS classes,
// but `data-name` on the avatar element is comparatively stable — walk up
// from there to the enclosing clickable row instead of relying on classes.
function navigateToConversation(sender) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => {
        const target = ${JSON.stringify(sender)};
        const el = Array.from(document.querySelectorAll('[data-name]'))
          .find((node) => node.getAttribute('data-name') === target);
        const row = el ? el.closest('[role="link"]') : null;
        if (row) { row.click(); return true; }
        return false;
      })()`,
    )
    .catch(() => {});
}

// Electron treats permission "checks" (synchronous, e.g. what Chat runs
// before actually creating a Notification) and permission "requests" (async,
// e.g. Notification.requestPermission()) as two separate hooks — unlike real
// Chrome, where they're unified. Wiring up only the request handler leaves
// the check handler on its restrictive default, so the request appears
// granted but Chat's own pre-flight check silently blocks it anyway.
const ALLOWED_PERMISSIONS = new Set([
  "notifications",
  "media",
  "clipboard-sanitized-write",
  "fullscreen",
]);

function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    },
  );
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
}

// Injects sw-preload.cjs into chat.google.com's own service worker context —
// the only way to patch code that runs there, since the regular frame
// preload can't reach it. See sw-preload.cjs for why this is needed.
function setupServiceWorkerPreload() {
  session.defaultSession.registerPreloadScript({
    type: "service-worker",
    filePath: path.join(__dirname, "sw-preload.cjs"),
  });
  // Service worker console output is a separate channel from the page's
  // webContents — forward it so sw-preload.cjs's logging is actually visible.
  if (process.env.DEBUG_NAV) {
    session.defaultSession.serviceWorkers.on("console-message", (event, details) => {
      console.log("[sw]", details.message);
    });
  }
}

// macOS gates real notification delivery behind its own UNUserNotifications
// authorization, separate from (and underneath) the in-page permission
// granted above. That OS prompt only appears the first time the app actually
// tries to show a notification — waiting for a real Chat message to trigger
// it means it may never surface until traffic happens to arrive. Firing a
// one-time real notification right after launch forces that prompt (or
// confirms delivery already works) instead of leaving it to chance.
function requestNotificationPermission() {
  if (!Notification.isSupported()) {
    if (process.env.DEBUG_NAV) console.log("[notif] Notification.isSupported() === false");
    return;
  }
  const marker = path.join(app.getPath("userData"), ".notification-permission-requested");
  if (fs.existsSync(marker)) return;
  const notification = new Notification({
    title: "Chat Wrapper",
    body: "Notifications are enabled — you'll be notified here when new Chat messages arrive.",
  });
  notification.on("show", () => {
    if (process.env.DEBUG_NAV) console.log("[notif] show event fired");
    try {
      fs.writeFileSync(marker, new Date().toISOString());
    } catch {
      // Non-fatal: worst case this fires again on the next launch.
    }
  });
  notification.on("failed", (event, error) => {
    console.error("[notif] failed to show notification:", error);
    // Don't write the marker — retry on next launch instead of masking it.
  });
  notification.show();
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
    // Requested only once the window is actually visible/foregrounded —
    // macOS's notification-authorization dialog can fail to surface
    // properly if requested before the app has a active, on-screen window.
    setTimeout(requestNotificationPermission, 1000);
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
    if (process.env.DEBUG_NAV) console.log("[title]", JSON.stringify(title));
    const match = title.match(/^\((\d+)\)/);
    updateBadge(match ? parseInt(match[1], 10) : 0);
    notifyFromTitle(title);
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

ipcMain.on("app-badge", (event, count) => {
  if (process.env.DEBUG_NAV) console.log("[badge-api]", count);
  updateBadge(count);
});

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
    setupServiceWorkerPreload();
    createWindow();
    createTray();
  });
}
