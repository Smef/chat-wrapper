const { ipcRenderer } = require('electron');

// Electron's Chromium build is unbranded, so navigator.userAgentData reports
// brands like "Chromium" with no "Google Chrome" entry. Google's sign-in JS
// reads this (separately from the UA string/headers) and bounces browsers it
// doesn't recognize to a marketing page instead of the real sign-in flow.
const CHROME_FULL_VERSION = process.versions.chrome;
const CHROME_MAJOR = CHROME_FULL_VERSION.split('.')[0];
const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const PLATFORM = PLATFORM_NAMES[process.platform] || 'Linux';

const fakeBrands = [
  { brand: 'Not)A;Brand', version: '8' },
  { brand: 'Chromium', version: CHROME_MAJOR },
  { brand: 'Google Chrome', version: CHROME_MAJOR },
];
const fakeFullVersionList = [
  { brand: 'Not)A;Brand', version: '8.0.0.0' },
  { brand: 'Chromium', version: CHROME_FULL_VERSION },
  { brand: 'Google Chrome', version: CHROME_FULL_VERSION },
];

const fakeUserAgentData = {
  brands: fakeBrands,
  mobile: false,
  platform: PLATFORM,
  getHighEntropyValues: (hints) =>
    Promise.resolve({
      brands: fakeBrands,
      mobile: false,
      platform: PLATFORM,
      platformVersion: '15.0.0',
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      bitness: '64',
      model: '',
      uaFullVersion: CHROME_FULL_VERSION,
      fullVersionList: fakeFullVersionList,
    }),
  toJSON() {
    return { brands: fakeBrands, mobile: false, platform: PLATFORM };
  },
};

try {
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => fakeUserAgentData,
    configurable: true,
  });
} catch {
  // best-effort spoof; sign-in still falls back to the legacy UA string
}

// Wrap the native Notification class so clicking a notification (even while
// the window is hidden in the tray) brings the app back to the front.
const NativeNotification = window.Notification;

class PatchedNotification extends NativeNotification {
  constructor(title, options) {
    if (process.env.DEBUG_NAV) console.log('[notif-page] Notification() constructed:', title);
    super(title, options);
    this.addEventListener('click', () => {
      ipcRenderer.send('notification-click');
    });
    this.addEventListener('error', (e) => {
      if (process.env.DEBUG_NAV) console.log('[notif-page] error event', e);
    });
  }

  static requestPermission(...args) {
    return NativeNotification.requestPermission(...args);
  }
}

Object.defineProperty(PatchedNotification, 'permission', {
  get: () => NativeNotification.permission,
});

window.Notification = PatchedNotification;

// Electron's "persistent" notification path (ServiceWorkerRegistration
// .showNotification, used for Chat's real background message notifications
// and its in-app "Show an example" preview) has a longstanding
// implementation gap and silently rejects: electron/electron#13041. When a
// page-context call fails, fall back to a plain page-context Notification —
// legal here, unlike inside the service worker itself. The service worker's
// own internal calls (sw-preload.cjs) can't construct a Notification
// directly, so they message this page to do it instead; listen for that too.
if (typeof ServiceWorkerRegistration !== 'undefined') {
  const nativeShowNotification = ServiceWorkerRegistration.prototype.showNotification;
  ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
    return nativeShowNotification.call(this, title, options).catch((error) => {
      if (process.env.DEBUG_NAV) console.log('[notif-page] showNotification failed, falling back:', error);
      const fallbackOptions = { ...options };
      delete fallbackOptions.actions; // only supported for persistent notifications
      return new window.Notification(title, fallbackOptions);
    });
  };
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.__swNotificationFallback) {
      try {
        new window.Notification(data.title, data.options);
      } catch (error) {
        if (process.env.DEBUG_NAV) console.log('[notif-page] SW fallback notification failed:', error);
      }
    }
  });
}

// Chat may signal unread counts via the modern Badging API instead of (or
// in addition to) changing document.title — forward both to the main
// process, which decides whether to fire a fallback notification.
if (navigator.setAppBadge) {
  const nativeSetAppBadge = navigator.setAppBadge.bind(navigator);
  navigator.setAppBadge = (count) => {
    ipcRenderer.send('app-badge', count ?? 0);
    return nativeSetAppBadge(count);
  };
}
if (navigator.clearAppBadge) {
  const nativeClearAppBadge = navigator.clearAppBadge.bind(navigator);
  navigator.clearAppBadge = () => {
    ipcRenderer.send('app-badge', 0);
    return nativeClearAppBadge();
  };
}

if (process.env.DEBUG_NAV) {
  window.addEventListener('DOMContentLoaded', async () => {
    if (!('serviceWorker' in navigator)) {
      console.log('[notif-page] no serviceWorker support');
      return;
    }
    const registrations = await navigator.serviceWorker.getRegistrations();
    console.log(
      '[notif-page] service worker registrations:',
      registrations.length,
      'controller:',
      !!navigator.serviceWorker.controller,
    );
  });
}
