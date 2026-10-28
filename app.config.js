const app = require('./app.json');
const { otaRuntimeVersion } = require('./scripts/ota-runtime-version');

/**
 * CDXC:Release 2026-10-23 DECISION: the phone app updates its JavaScript over the air from our own
 * server, a Cloudflare Worker with R2 at ota.ghostex.dev (user picked "Self-hosted (R2 + a small
 * Worker)" over EAS Update, gxserver and hot-updater). Every update is signed in CI with a key that
 * never leaves the release secrets; the binary carries only the certificate (certs/certificate.pem).
 * Release builds and update exports (GHOSTEX_RELEASE_VERSION set) turn updates on; local and dev
 * builds keep them off so Metro always wins.
 * SEE-ALSO: tooling/release-mobile/ota-server/ (the Worker), tooling/release-mobile/ota-publish.mjs.
 */
// GHOSTEX_OTA_SERVER points a test build at another server (a local `wrangler dev`, for example),
// as it does for tooling/release-mobile/ota-publish.mjs.
const OTA_MANIFEST_URL = `${(process.env.GHOSTEX_OTA_SERVER || 'https://ota.ghostex.dev').replace(/\/+$/, '')}/v1/manifest/production`;

function releaseBuildNumber(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`GHOSTEX_RELEASE_VERSION must be MAJOR.MINOR.PATCH, got ${version}`);
  }
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
}

// Android in-app self-update from GitHub Releases. The app is distributed as a
// sideloaded APK today, so it checks GitHub for a newer release and installs it
// through the system package installer. Google Play rejects apps that install
// other packages, so set GHOSTEX_ANDROID_SELF_UPDATE=0 before a Play Store
// build: that blocks the REQUEST_INSTALL_PACKAGES permission in the manifest
// on the next `expo prebuild` and makes `ANDROID_SELF_UPDATE_ENABLED`
// (src/config/featureFlags.ts) false, which removes the update check and UI.
// The permission is blocked (tools:node="remove"), not just left out, so a
// prebuild over an android/ folder generated for the GitHub APK, or a library
// that declares it, cannot carry it into the Play build.
// `tooling/release-mobile/android.sh` (GHOSTEX_ANDROID_DISTRIBUTION=play)
// fails the build when it is still there.
const ANDROID_SELF_UPDATE_PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';

function androidSelfUpdateEnabled() {
  const raw = process.env.GHOSTEX_ANDROID_SELF_UPDATE;
  if (raw === undefined || raw === '' || raw === '1') return true;
  if (raw === '0') return false;
  throw new Error(`GHOSTEX_ANDROID_SELF_UPDATE must be 0 or 1, got ${raw}`);
}

// Elias's fork build (scripts/fork/phone-testflight.sh in the Ghostex fork sets GHOSTEX_FORK_BUILD=1):
// its own bundle id, team, name ("Ghostex Fork") and badged icon, so his TestFlight build installs
// next to the official app instead of replacing it. Over-the-air updates are always off for it:
// ota.ghostex.dev serves upstream-signed JavaScript that would overwrite the fork's. The ghostex.dev
// universal link is dropped too (its apple-app-site-association names only the official app); the
// pairing QR still scans in the app. Without the variable nothing here changes.
const FORK_BUILD = process.env.GHOSTEX_FORK_BUILD === '1';
const FORK_BUNDLE_ID = process.env.GHOSTEX_FORK_BUNDLE_ID || 'com.eliasx45.ghostex.fork';
const FORK_TEAM_ID = process.env.GHOSTEX_FORK_TEAM_ID || 'GQQBT37P3D';
const FORK_DISPLAY_NAME = 'Ghostex Fork';

function forkIos(ios) {
  // eslint-disable-next-line no-unused-vars
  const { associatedDomains, ...rest } = ios;
  return {
    ...rest,
    bundleIdentifier: FORK_BUNDLE_ID,
    appleTeamId: FORK_TEAM_ID,
    icon: './assets/icon-fork.png',
    entitlements: {
      ...ios.entitlements,
      'application-identifier': `$(AppIdentifierPrefix)${FORK_BUNDLE_ID}`,
      'keychain-access-groups': [`$(AppIdentifierPrefix)${FORK_BUNDLE_ID}`],
    },
    // Set here, Expo's withDisplayName leaves CFBundleDisplayName alone, so `name` (and with it the
    // Xcode project, scheme and Ghostex.app) stays Ghostex.
    infoPlist: { ...ios.infoPlist, CFBundleDisplayName: FORK_DISPLAY_NAME },
  };
}

module.exports = () => {
  const version = process.env.GHOSTEX_RELEASE_VERSION || app.expo.version;
  const buildNumber = process.env.GHOSTEX_RELEASE_BUILD_NUMBER || String(releaseBuildNumber(version));
  const androidSelfUpdate = androidSelfUpdateEnabled();
  const basePermissions = app.expo.android.permissions ?? [];
  const baseBlockedPermissions = app.expo.android.blockedPermissions ?? [];
  const overTheAir = !FORK_BUILD && Boolean(process.env.GHOSTEX_RELEASE_VERSION);

  return {
    ...app.expo,
    version,
    extra: {
      ...app.expo.extra,
      androidSelfUpdate,
    },
    updates: overTheAir
      ? {
          enabled: true,
          url: OTA_MANIFEST_URL,
          // Check at every launch without waiting: the app starts on what it has, the download
          // runs in the background, and the update applies at the next launch or on Restart.
          checkAutomatically: 'ON_LOAD',
          fallbackToCacheTimeout: 0,
          codeSigningCertificate: './certs/certificate.pem',
          codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
          // The server sends whole bundles; there is no patch to ask for.
          enableBsdiffPatchSupport: false,
        }
      : { enabled: false },
    ios: {
      ...(FORK_BUILD ? forkIos(app.expo.ios) : app.expo.ios),
      buildNumber,
      runtimeVersion: overTheAir ? otaRuntimeVersion('ios', { androidSelfUpdate }) : 'dev',
    },
    android: {
      ...app.expo.android,
      runtimeVersion: overTheAir ? otaRuntimeVersion('android', { androidSelfUpdate }) : 'dev',
      versionCode: Number(buildNumber),
      permissions: androidSelfUpdate ? [...basePermissions, ANDROID_SELF_UPDATE_PERMISSION] : basePermissions,
      blockedPermissions: androidSelfUpdate
        ? baseBlockedPermissions
        : [...baseBlockedPermissions, ANDROID_SELF_UPDATE_PERMISSION],
    },
  };
};
