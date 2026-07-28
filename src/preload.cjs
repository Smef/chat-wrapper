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
    super(title, options);
    this.addEventListener('click', () => {
      ipcRenderer.send('notification-click');
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
