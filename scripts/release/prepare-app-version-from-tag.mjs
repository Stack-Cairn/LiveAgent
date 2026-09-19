#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { msiVersionFor, parseReleaseVersion, tauriVersionConfig } from "./release-version.mjs";

function usage() {
  return [
    "Usage: prepare-app-version-from-tag.mjs <release-tag> [options]",
    "",
    "Options:",
    "  --github-env <path>      Append LIVEAGENT_* variables for later workflow steps.",
    "  --github-output <path>   Append release metadata as GitHub Action step outputs.",
    "  --tauri-config <path>    Write a generated Tauri config overlay with the app version.",
    "  --json                   Print metadata as JSON.",
  ].join("\n");
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    githubEnvPath: undefined,
    githubOutputPath: undefined,
    json: false,
    releaseTag: undefined,
    tauriConfigPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--github-env") {
      options.githubEnvPath = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--github-output") {
      options.githubOutputPath = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--tauri-config") {
      options.tauriConfigPath = readValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (options.releaseTag) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    options.releaseTag = arg;
  }

  return options;
}

function appendLines(path, lines) {
  appendFileSync(path, `${lines.join("\n")}\n`);
}

function writeTauriConfig(path, appVersion) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(tauriVersionConfig(appVersion), null, 2)}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const metadata = parseReleaseVersion(
    options.releaseTag || process.env.LIVEAGENT_RELEASE_TAG || process.env.RELEASE_TAG,
  );
  const msiVersion = msiVersionFor(metadata.appVersion);

  if (options.tauriConfigPath) {
    writeTauriConfig(options.tauriConfigPath, metadata.appVersion);
  }

  if (options.githubEnvPath) {
    const envLines = [
      `LIVEAGENT_RELEASE_TAG=${metadata.releaseTag}`,
      `LIVEAGENT_APP_VERSION=${metadata.appVersion}`,
      `LIVEAGENT_IS_PRERELEASE=${metadata.isPrerelease}`,
    ];
    if (options.tauriConfigPath) {
      envLines.push(`LIVEAGENT_TAURI_VERSION_CONFIG=${options.tauriConfigPath}`);
    }
    appendLines(options.githubEnvPath, envLines);
  }

  if (options.githubOutputPath) {
    const outputLines = [
      `release_tag=${metadata.releaseTag}`,
      `app_version=${metadata.appVersion}`,
      `is_prerelease=${metadata.isPrerelease}`,
    ];
    if (options.tauriConfigPath) {
      outputLines.push(`tauri_version_config=${options.tauriConfigPath}`);
    }
    appendLines(options.githubOutputPath, outputLines);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...metadata,
          msiVersion: msiVersion ?? null,
          tauriVersionConfig: options.tauriConfigPath,
        },
        null,
        2,
      ),
    );
  } else {
    const configSuffix = options.tauriConfigPath
      ? ` Wrote Tauri version config: ${options.tauriConfigPath}.`
      : "";
    const msiSuffix = msiVersion ? ` MSI version override: ${msiVersion}.` : "";
    console.log(
      `Prepared LiveAgent ${metadata.releaseTag} (app version ${metadata.appVersion}, prerelease ${metadata.isPrerelease}).${msiSuffix}${configSuffix}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(1);
}
