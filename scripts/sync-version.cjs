#!/usr/bin/env node
/**
 * Synchronizes version between package.json and app.json,
 * and manages Android versionCode and iOS buildNumber.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(path.dirname(module.filename), '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const appJsonPath = path.join(rootDir, 'app.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function run(args = process.argv.slice(2)) {
  const isCheck = args.includes('--check');
  const noIncrement = args.includes('--no-increment');
  let releaseTag;
  let apkPath;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check' || arg === '--no-increment') continue;
    if (arg === '--tag' && isCheck && releaseTag === undefined) {
      releaseTag = args[++index];
      if (releaseTag && !releaseTag.startsWith('--')) continue;
    }
    if (arg === '--apk' && isCheck && apkPath === undefined) {
      apkPath = args[++index];
      if (apkPath && !apkPath.startsWith('--')) continue;
    }
    console.error('Usage: sync-version.cjs [--no-increment] | --check [--tag v<version>] [--apk file.apk]');
    return 1;
  }

  const packageJson = readJson(packageJsonPath);
  const appJson = readJson(appJsonPath);
  const targetVersion = packageJson.version;
  const currentAppVersion = appJson.expo?.version;
  const rawVersionCode = appJson.expo?.android?.versionCode;
  const currentVersionCode = Number(rawVersionCode) || 1;

  if (isCheck) {
    let hasErrors = false;
    if (typeof targetVersion !== 'string' || !targetVersion || currentAppVersion !== targetVersion) {
      console.error(`❌ Version mismatch: package.json (${targetVersion}) vs app.json (${currentAppVersion})`);
      hasErrors = true;
    }
    if (!Number.isSafeInteger(rawVersionCode) || rawVersionCode < 1 || rawVersionCode > 2100000000) {
      console.error(`❌ Missing or invalid android.versionCode in app.json: ${rawVersionCode}`);
      hasErrors = true;
    }
    if (releaseTag !== undefined && releaseTag !== `v${targetVersion}`) {
      console.error(`❌ Release tag mismatch: ${releaseTag} vs expected v${targetVersion}`);
      hasErrors = true;
    }
    if (hasErrors) return 1;
    if (apkPath !== undefined) {
      let apkVersion;
      try {
        apkVersion = execFileSync('apkanalyzer', ['manifest', 'version-name', apkPath], {
          encoding: 'utf8',
        }).trim();
      } catch (error) {
        console.error(`Could not read APK version: ${error.message}`);
        return 1;
      }
      if (apkVersion !== targetVersion) {
        console.error(`APK version mismatch: ${apkVersion} vs expected ${targetVersion}`);
        return 1;
      }
    }
    console.log(`✅ Versions match: ${targetVersion} (versionCode: ${currentVersionCode})`);
    return 0;
  }

  if (!appJson.expo) appJson.expo = {};
  if (!appJson.expo.android) appJson.expo.android = {};
  if (!appJson.expo.ios) appJson.expo.ios = {};

  const nextVersionCode = noIncrement ? currentVersionCode : currentVersionCode + 1;
  appJson.expo.version = targetVersion;
  appJson.expo.android.versionCode = nextVersionCode;
  appJson.expo.ios.buildNumber = String(nextVersionCode);

  writeJson(appJsonPath, appJson);
  console.log(`Synced version: ${targetVersion} (versionCode: ${nextVersionCode}, buildNumber: ${nextVersionCode})`);
  return 0;
}

module.exports = { run };

if (require.main === module) {
  process.exitCode = run();
}
