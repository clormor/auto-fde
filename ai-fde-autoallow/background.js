// Service worker: decides when the toolbar button is usable, and injects
// autoallow.js into the page when it is pressed.
//
// Three deliberate choices, all worth knowing before you change anything here.
//
// world: "MAIN"
//   autoallow.js runs in the page's own JavaScript context, which is what you
//   get when you paste into the DevTools console. It has to run there because
//   setTextareaValue() reaches for the page's own HTMLTextAreaElement
//   descriptor to defeat React's patched value setter. From an isolated world
//   it would be reading a different prototype and React would not register the
//   change. The window.__aiFdeAutoAllow guard also relies on being visible to
//   the page, so a second press finds the existing panel instead of stacking
//   another one on top.
//
// Button state
//   The button is disabled by default and only enabled on Foundry AI FDE
//   session pages. autoallow.js already refuses to run anywhere else, but a
//   greyed-out button answers "why is nothing happening?" before anyone has to
//   open the console to find out.
//
// Failure reporting
//   Anything this worker logs lands in the service worker console, which is a
//   separate console from the page's and which nobody outside this repo will
//   think to open. So every failure also writes its reason into the button's
//   tooltip. Hovering the button is the diagnostic.

const HOST = "palantirfoundry.com";
const PATH_MARKER = "/ai-fde/";

const TITLE_READY = "Start AutoAllow on this AI FDE session";
const TITLE_WRONG_PAGE = "AutoAllow only runs on Foundry AI FDE session pages";

const BADGE_PROBLEM_MS = 15000;
const BADGE_OK_MS = 3000;

function isTargetUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.hostname !== HOST && !u.hostname.endsWith("." + HOST)) return false;
    return u.pathname.includes(PATH_MARKER);
  } catch {
    return false;
  }
}

// Turns a rejected URL into a sentence a colleague can act on. A tab object
// with no url at all is its own case: that is Chrome withholding the address
// because the page falls outside the extension's permitted sites, which reads
// nothing like a session page whose path is simply wrong.
function describeUrlMismatch(url) {
  if (!url) {
    return "Chrome would not give the extension this tab's address, which means " +
      "the page is outside the sites the extension is allowed to see";
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    return "Chrome reported an address the extension could not parse: " + url;
  }
  if (u.protocol !== "https:") return "this tab is " + u.protocol + " not https";
  if (u.hostname !== HOST && !u.hostname.endsWith("." + HOST)) {
    return "this tab is on " + u.hostname + ", not " + HOST;
  }
  return "this tab's path is " + u.pathname + ", which does not contain " + PATH_MARKER;
}

async function refreshButton(tabId, url) {
  try {
    if (isTargetUrl(url)) {
      await chrome.action.enable(tabId);
      await chrome.action.setTitle({ tabId, title: TITLE_READY });
    } else {
      await chrome.action.disable(tabId);
      await chrome.action.setTitle({ tabId, title: TITLE_WRONG_PAGE });
    }
  } catch {
    // Tab closed between the event firing and this call. Nothing to do.
  }
}

// A freshly installed or freshly reloaded extension holds no per-tab state, so
// an AI FDE session that was already open sits behind a greyed-out button until
// it is reloaded or switched away from and back. Sweeping the open tabs on
// install and on browser startup removes that trap.
async function refreshAllTabs() {
  try {
    await chrome.action.disable();
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(t => refreshButton(t.id, t.url)));
  } catch (err) {
    console.warn("[AutoAllow] could not sweep open tabs:", err);
  }
}

chrome.runtime.onInstalled.addListener(refreshAllTabs);
chrome.runtime.onStartup.addListener(refreshAllTabs);

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
  if (!tab || !tab.id) return;

  if (!isTargetUrl(tab.url)) {
    flagProblem(tab.id, describeUrlMismatch(tab.url));
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["autoallow.js"],
      world: "MAIN"
    });
  } catch (err) {
    console.error("[AutoAllow] injection failed:", err);
    flagProblem(tab.id, "Chrome refused to inject the script: " + err.message);
    return;
  }

  flagStarted(tab.id);
}

// Feedback path that works even when we have no script access to the page. The
// reason goes in the tooltip as well as the console, because the tooltip is the
// only text a colleague can reach without opening DevTools.
function flagProblem(tabId, reason) {
  console.warn("[AutoAllow] " + reason);
  setBadge(tabId, "!", "#c0392b", "AutoAllow did not start: " + reason);
  restoreAfter(tabId, BADGE_PROBLEM_MS);
}

// The panel can open behind page furniture or off the edge of a small window,
// so a press that worked has to look different from one that did not.
function flagStarted(tabId) {
  setBadge(tabId, "on", "#2f9e44", "AutoAllow injected. Look for the panel, bottom right.");
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
  if (command !== "start-autoallow") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  start(tab);
});
