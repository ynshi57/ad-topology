/**
 * Active nexis-config platform selection.
 *
 * ad_dag ships per-platform launch profiles (25_6090 / 26_6012) that differ in
 * canbus, localization and model_infer wiring. The build step emits one topology
 * config per platform; this module lets the UI switch between them at runtime
 * without a rebuild. Consumers should read getActiveConfig() lazily (inside
 * functions), not capture it at import time, so a switch takes effect.
 */
import cfg_25_6090 from './nexis-config.25_6090.json';
import cfg_26_6012 from './nexis-config.26_6012.json';

const CONFIGS = {
  '25_6090': cfg_25_6090,
  '26_6012': cfg_26_6012,
};
const DEFAULT_PLATFORM = '26_6012';
const STORAGE_KEY = 'ad-topology-config-platform';

let activePlatform = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && CONFIGS[saved]) return saved;
  } catch {
    // localStorage unavailable (e.g. SSR / sandbox) — fall through to default.
  }
  return DEFAULT_PLATFORM;
})();

export function listPlatforms() {
  return Object.keys(CONFIGS);
}

export function getActivePlatform() {
  return activePlatform;
}

export function getActiveConfig() {
  return CONFIGS[activePlatform];
}

export function setActivePlatform(platform) {
  if (!CONFIGS[platform]) {
    throw new Error(`unknown platform '${platform}'. Known: ${Object.keys(CONFIGS).join(', ')}`);
  }
  activePlatform = platform;
  try {
    localStorage.setItem(STORAGE_KEY, platform);
  } catch {
    // Persisting the choice is best-effort; the in-memory switch still applies.
  }
  return CONFIGS[platform];
}
