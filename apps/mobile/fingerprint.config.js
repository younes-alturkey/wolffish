// Tunes the runtime-version fingerprint (@expo/fingerprint, used by
// expo-updates and EAS). The fingerprint decides OTA compatibility: an update
// only reaches binaries whose build-time hash equals the publish-time hash.
// These skips exclude inputs that never change the native binary, so version
// bumps (provision/ota) and script edits don't fork the runtime. NOTE: this
// list REPLACES the library default, it does not merge with it.
// - ExpoConfigVersions: expo.version / ios.buildNumber / android.versionCode
// - ExpoConfigExtraSection: expo.extra is JS-visible data, not native surface
// - PackageJsonScriptsAll: npm scripts are dev tooling (covers the default
//   PackageJsonAndroidAndIosScriptsIfNotContainRun and more)
/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: [
    'ExpoConfigVersions',
    'ExpoConfigRuntimeVersionIfString',
    'ExpoConfigExtraSection',
    'PackageJsonScriptsAll'
  ]
}
