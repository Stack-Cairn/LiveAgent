export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Maximum value Windows Installer accepts in a single ProductVersion field. */
const MSI_VERSION_FIELD_MAX = 65535;

function parseAppVersion(appVersion) {
  const match = SEMVER_PATTERN.exec(String(appVersion ?? ""));
  if (!match) {
    throw new Error(`App version must be a valid semver string. Received: ${appVersion}`);
  }

  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4],
  };
}

/**
 * Windows Installer requires the MSI `ProductVersion` to be numeric-only
 * (`major.minor.patch[.build]`), so Tauri aborts the `msi` bundle for named prereleases such as
 * `1.3.6-beta.1`. Tauri already derives the build number from numeric-only prereleases
 * (`1.3.6-1` -> `1.3.6.1`); mirror that derivation so named prereleases can ship an MSI while the
 * app version keeps its semver form for the About page and the updater.
 *
 * Returns undefined when Tauri's own derivation is already valid.
 */
function deriveMsiVersion({ major, minor, patch, prerelease }) {
  if (!prerelease) {
    return undefined;
  }

  const identifiers = prerelease.split(".");
  const isNumericIdentifier = (identifier) =>
    /^\d+$/.test(identifier) && Number(identifier) <= MSI_VERSION_FIELD_MAX;
  if (identifiers.every(isNumericIdentifier)) {
    return undefined;
  }

  // `1.3.6-beta.1` -> build 1, `1.3.6-beta` / `1.3.6-rc` -> build 0.
  const buildIdentifier = [...identifiers].reverse().find((identifier) => /^\d+$/.test(identifier));
  const build = buildIdentifier ? Math.min(Number(buildIdentifier), MSI_VERSION_FIELD_MAX) : 0;
  return `${major}.${minor}.${patch}.${build}`;
}

export function normalizeReleaseTag(input) {
  const rawTag = String(input ?? "").trim();
  if (!rawTag) {
    throw new Error("Release tag is required. Example: v0.1.3");
  }

  const releaseTag = rawTag.replace(/^refs\/tags\//, "");
  if (!releaseTag.startsWith("v")) {
    throw new Error(`Release tag must start with "v". Received: ${rawTag}`);
  }

  const appVersion = releaseTag.slice(1);
  if (!SEMVER_PATTERN.test(appVersion)) {
    throw new Error(`Release tag must be a semver tag like v0.1.3. Received: ${rawTag}`);
  }

  return releaseTag;
}

export function parseReleaseVersion(input) {
  const releaseTag = normalizeReleaseTag(input);
  const appVersion = releaseTag.slice(1);

  return {
    appVersion,
    isPrerelease: appVersion.split("+", 1)[0].includes("-"),
    releaseTag,
  };
}

/** MSI version override for a release app version, or undefined when none is needed. */
export function msiVersionFor(appVersion) {
  return deriveMsiVersion(parseAppVersion(appVersion));
}

export function tauriVersionConfig(appVersion) {
  const msiVersion = deriveMsiVersion(parseAppVersion(appVersion));
  if (!msiVersion) {
    return {
      version: appVersion,
    };
  }

  return {
    version: appVersion,
    bundle: {
      windows: {
        wix: {
          version: msiVersion,
        },
      },
    },
  };
}
