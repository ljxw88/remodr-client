#!/usr/bin/env node
/**
 * Synchronizes version between package.json and app.json,
 * and manages Android versionCode and iOS buildNumber.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const appJsonPath = path.join(rootDir, 'app.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const args = process.argv.slice(2);
const isCheck = args.includes('--check');
const noIncrement = args.includes('--no-increment');

const packageJson = readJson(packageJsonPath);
const appJson = readJson(appJsonPath);

if (!appJson.expo) appJson.expo = {};
if (!appJson.expo.android) appJson.expo.android = {};
if (!appJson.expo.ios) appJson.expo.ios = {};

const targetVersion = packageJson.version;
const currentAppVersion = appJson.expo.version;
const currentVersionCode = Number(appJson.expo.android.versionCode) || 1;

if (isCheck) {
  let hasErrors = false;
  if (currentAppVersion !== targetVersion) {
    console.error(`❌ Version mismatch: package.json (${targetVersion}) vs app.json (${currentAppVersion})`);
    hasErrors = true;
  }
  if (!appJson.expo.android.versionCode || currentVersionCode < 1) {
    console.error(`❌ Missing or invalid android.versionCode in app.json: ${appJson.expo.android.versionCode}`);
    hasErrors = true;
  }
  if (hasErrors) {
    process.exit(1);
  }
  console.log(`✅ Versions match: ${targetVersion} (versionCode: ${currentVersionCode})`);
  process.exit(0);
}

const nextVersionCode = noIncrement ? currentVersionCode : currentVersionCode + 1;

appJson.expo.version = targetVersion;
appJson.expo.android.versionCode = nextVersionCode;
appJson.expo.ios.buildNumber = String(nextVersionCode);

writeJson(appJsonPath, appJson);

console.log(`Synced version: ${targetVersion} (versionCode: ${nextVersionCode}, buildNumber: ${nextVersionCode})`);
