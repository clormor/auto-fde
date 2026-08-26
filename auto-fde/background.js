// Service worker: decides when the toolbar button is usable, and injects
// auto-fde.js into the page when it is pressed.
//
// Four things here are deliberate and worth knowing before changing anything.
//
// world: "MAIN"
//   auto-fde.js runs in the page's own JavaScript context, which is what you
//   get when you paste into the DevTools console. It has to run there because
//   setTextareaValue() reaches for the page's own HTMLTextAreaElement
//   descriptor to defeat React's patched value setter. From an isolated world
//   it would be reading a different prototype and React would not register the
//   change. The window.__autoFde guard also relies on being visible to
//   the page, so a second press finds the existing panel instead of stacking
//   another one on top.
//
// Config is injected, not imported
//   A MAIN-world script cannot see chrome.storage or chrome.runtime, so the
//   configured origins and the manifest version are written onto the page as
//   window.__autoFdeConfig by a separate injection immediately before the
//   script itself. The version is read here, where the manifest is reachable,
//   so the panel can show which revision is running.
//
// Button state
//   The icon goes greyscale on pages where the script would refuse to run, and
//   the tooltip says why, which answers "why is nothing happening?" before
//   anyone has to press anything. What does not happen here is
//   chrome.action.disable(): see describeButtonState() in gate.js for why. The
//   button stays live on every page, so a press somewhere it cannot run gives a
//   reason rather than silence.
//
// Failure reporting
//   Anything this worker logs lands in the service worker console, which is a
//   separate console from the page's and which nobody outside this repo will
//   think to open. So every failure also writes its reason into the button's
//   tooltip. Hovering the button is the diagnostic.

import { PATH_MARKER, isTargetUrl, describeUrlMismatch, describeButtonState } from "./gate.js";
import { readOrigins, STORAGE_KEY, STORAGE_AREA } from "./storage.js";

const BADGE_PROBLEM_MS = 15000;
const BADGE_OK_MS = 3000;

const ICON_ACTIVE = {
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png"
};
const ICON_INACTIVE = {
  16: "icons/icon16-inactive.png",
  32: "icons/icon32-inactive.png",
  48: "icons/icon48-inactive.png",
  128: "icons/icon128-inactive.png"
};

async function refreshButton(tabId, url) {
  // chrome.action.setIcon with no tab id sets the icon for every tab rather than
  // doing nothing, so one tab Chrome will not give an id for, a devtools window
  // among them, would repaint the whole toolbar from that tab's address.
  // chrome.tabs.TAB_ID_NONE is -1.
  if (typeof tabId !== "number" || tabId < 0) return;

  const origins = await readOrigins();
  const state = describeButtonState(url, origins);
  try {
    await chrome.action.setIcon({ tabId, path: state.ready ? ICON_ACTIVE : ICON_INACTIVE });
    await chrome.action.setTitle({ tabId, title: state.title });
  } catch {
    // Tab closed between the event firing and this call. Nothing to do.
  }
}

// A freshly installed or freshly reloaded extension holds no per-tab state, so
// an AI FDE session that was already open keeps the grey icon and the wrong
// tooltip until it is reloaded or switched away from and back. Sweeping the open
// tabs removes that trap. The same sweep runs whenever the configured origins change, so
// adding a base URL lights up the tabs already sitting on it.
async function refreshAllTabs() {
  try {
    // Undoes any disabled state left behind by an older version of this
    // extension, which used to disable the action per tab.
    await chrome.action.enable();
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(t => refreshButton(t.id, t.url)));
  } catch (err) {
    console.warn("[Auto FDE] could not sweep open tabs:", err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await refreshAllTabs();
  // An extension with nothing configured cannot do anything at all, so send the
  // user straight to the one page that fixes that.
  const origins = await readOrigins();
  if (origins.length === 0) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(refreshAllTabs);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === STORAGE_AREA && changes[STORAGE_KEY]) refreshAllTabs();
});

// Granting or revoking host access changes which tab URLs Chrome will even show
// us, which changes the button state.
chrome.permissions.onAdded.addListener(refreshAllTabs);
chrome.permissions.onRemoved.addListener(refreshAllTabs);

// Covers normal page loads and the in-app navigations the AI FDE console does
// without a full reload.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    refreshButton(tabId, changeInfo.url || tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    refreshButton(tabId, tab.url);
  } catch {
    // Tab already gone.
  }
});

async function start(tab) {
  if (!tab || typeof tab.id !== "number") return;

  const origins = await readOrigins();
  if (origins.length === 0) {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (!isTargetUrl(tab.url, origins)) {
    flagProblem(tab.id, describeUrlMismatch(tab.url, origins));
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (allowed, marker, version) => {
        window.__autoFdeConfig = { origins: allowed, pathMarker: marker, version };
      },
      args: [origins, PATH_MARKER, chrome.runtime.getManifest().version]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["auto-fde.js"],
      world: "MAIN"
    });
  } catch (err) {
    console.error("[Auto FDE] injection failed:", err);
    flagProblem(tab.id, "Chrome refused to inject the script: " + err.message);
    return;
  }

  flagStarted(tab.id);
}

// Feedback path that works even when we have no script access to the page. The
// reason goes in the tooltip as well as the console, because the tooltip is the
// only text a colleague can reach without opening DevTools.
function flagProblem(tabId, reason) {
  console.warn("[Auto FDE] " + reason);
  setBadge(tabId, "!", "#c0392b", "Auto FDE: " + reason);
  restoreAfter(tabId, BADGE_PROBLEM_MS);
}

// The panel can open behind page furniture or off the edge of a small window,
// so a press that worked has to look different from one that did not.
function flagStarted(tabId) {
  setBadge(tabId, "on", "#2f9e44", "Auto FDE injected. Look for the panel, bottom right.");
  restoreAfter(tabId, BADGE_OK_MS);
}

function setBadge(tabId, text, colour, title) {
  try {
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color: colour });
    chrome.action.setTitle({ tabId, title });
  } catch {
    // Tab closed. Nothing to report to.
  }
}

function restoreAfter(tabId, ms) {
  setTimeout(async () => {
    try {
      chrome.action.setBadgeText({ tabId, text: "" });
      const tab = await chrome.tabs.get(tabId);
      refreshButton(tabId, tab.url);
    } catch {
      // Tab closed while the badge was up.
    }
  }, ms);
}

chrome.action.onClicked.addListener(start);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "start-auto-fde") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  start(tab);
});
