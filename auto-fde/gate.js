// The URL gate and the toolbar button's state, kept free of chrome APIs so both
// can be imported and tested in plain node.
//
// Two rules decide whether Auto FDE may run on a page:
//
//   1. the page's origin is one the user added in the options page
//   2. the path contains PATH_MARKER
//
// Rule 1 is exact-origin matching, deliberately. Wildcard subdomains would be
// convenient for anyone with several stacks, but they widen the blast radius of
// a typo and invite lookalike hosts, and adding a second origin costs one line
// in the options page. Rule 2 is fixed: it is how a Foundry AI FDE session is
// told apart from the rest of the Foundry workspace.

export const PATH_MARKER = "/ai-fde/";

export function isTargetUrl(url, origins) {
  if (!Array.isArray(origins) || origins.length === 0) return false;
  const u = parseHttps(url);
  if (!u) return false;
  if (!origins.includes(u.origin)) return false;
  return u.pathname.includes(PATH_MARKER);
}

// What the toolbar button should look like and say on a given page.
//
// Note what this does not return: a disabled state. chrome.action.disable() is
// not used anywhere, and reintroducing it would be a regression. In Manifest V3
// it no longer greys the toolbar icon, so the only thing it changes is the
// click, and a disabled action's click opens the extension's context menu
// instead of firing onClicked. That gives a coloured button that appears to do
// nothing, which is worse than no signal at all. The icon carries the signal
// instead, and the button stays live everywhere so that a press on the wrong
// page can say why.
export function describeButtonState(url, origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    return { ready: false, needsSetup: true, title: "Auto FDE: " + describeUrlMismatch(url, origins) };
  }
  if (isTargetUrl(url, origins)) {
    return { ready: true, needsSetup: false, title: "Open Auto FDE" };
  }
  return { ready: false, needsSetup: false, title: "Auto FDE: " + describeUrlMismatch(url, origins) };
}

// Turns whatever the user typed into an origin, or null if it cannot be one.
// Accepts a bare host so nobody has to remember the scheme, accepts a full
// session URL so pasting the address bar works, and throws away everything
// after the origin either way.
export function normaliseOrigin(input) {
  const trimmed = String(input == null ? "" : input).trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;

  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  // A wildcard would be read literally by permissions.request and match nothing,
  // so refusing it here is clearer than granting a permission that never fires.
  if (u.hostname.includes("*")) return null;
  return u.origin;
}

// The match pattern chrome.permissions wants for an origin.
export function permissionPattern(origin) {
  return origin + "/*";
}

// What a colleague reads in the button's tooltip when a press is refused.
//
// Short, because it is read at a glance on a hover and it is the only diagnostic
// reachable without opening DevTools. It says which of the checks failed and
// stops. Earlier versions quoted the whole path back, which on a Foundry URL
// full of resource identifiers buried the point in eighty characters of noise.
export function describeUrlMismatch(url, origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    return "no Foundry base URL set. Press to set one up.";
  }
  if (!url) return "Chrome will not share this tab's address.";

  let u;
  try {
    u = new URL(url);
  } catch {
    return "Chrome reported an address that will not parse.";
  }
  if (u.protocol !== "https:") return "not an https page.";
  // Naming the origin is worth the words: it is how a typo in the options page
  // gets spotted. The full list of configured origins is not.
  if (!origins.includes(u.origin)) return u.hostname + " is not a base URL you added.";
  return "not an AI FDE session.";
}

function parseHttps(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}
