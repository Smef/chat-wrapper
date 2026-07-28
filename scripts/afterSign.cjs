const { execFileSync } = require("node:child_process");
const path = require("node:path");

// electron-builder skips signing entirely when it can't find a "Developer ID
// Application" identity, leaving the app bundle with Electron's own generic
// ad-hoc signature (Identifier=Electron, no Info.plist bound). macOS then
// can't tell this app apart from any other unsigned Electron dev build, so
// framework-level permission decisions (e.g. notifications) never persist
// against a stable identity. Re-signing ad-hoc ourselves — free, no paid
// account needed — binds the signature to this app's actual bundle
// identifier and Info.plist instead.
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync("codesign", ["--deep", "--force", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
