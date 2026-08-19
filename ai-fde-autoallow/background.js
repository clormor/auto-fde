// Service worker: decides when the toolbar button is usable, and injects
// autoallow.js into the page when it is pressed.
//
// Two deliberate choices, both worth knowing before you change anything here.
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

const HOST = "palantirfoundry.com";
const PATH_MARKER = "/ai-fde/";

const TITLE_READY = "Start AutoAllow on this AI FDE session";
const TITLE_WRONG_PAGE = "AutoAllow only runs on Foundry AI FDE session pages";

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

// Disabled everywhere until a tab proves otherwise.
chrome.runtime.onInstalled.addListener(() => chrome.action.disable());
chrome.runtime.onStartup.addListener(() => chrome.action.disable());

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
    flagProblem(tab.id, "not an AI FDE session page");
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
    flagProblem(tab.id, err.message);
  }
}

// Feedback path that works even when we have no script access to the page.
function flagProblem(tabId, reason) {
  console.warn("[AutoAllow] " + reason);
  chrome.action.setBadgeText({ tabId, text: "!" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#c0392b" });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 4000);
}

chrome.action.onClicked.addListener(start);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "start-autoallow") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  start(tab);
});
