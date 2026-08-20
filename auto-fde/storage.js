// Where the configured Foundry origins live.
//
// chrome.storage.sync, not a file: it survives extension reloads and browser
// restarts, follows the Chrome profile to the user's other machines, and never
// lands in the repository. Nothing here ships with a default. An open-source
// build has no idea which Foundry instance it is pointed at, and guessing one
// would put somebody else's hostname in everyone's extension.

export const STORAGE_KEY = "foundryOrigins";
export const STORAGE_AREA = "sync";

export async function readOrigins() {
  try {
    const stored = await chrome.storage[STORAGE_AREA].get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    return Array.isArray(value) ? value.filter(o => typeof o === "string") : [];
  } catch (err) {
    // Storage unavailable means unconfigured, which the callers already handle.
    console.warn("[Auto FDE] could not read stored origins:", err);
    return [];
  }
}

export async function writeOrigins(origins) {
  await chrome.storage[STORAGE_AREA].set({ [STORAGE_KEY]: origins });
}
