// Options page: adds and removes the Foundry origins Auto FDE is allowed to
// run on.
//
// Adding an origin does two things that have to succeed together: it stores the
// origin, and it asks Chrome for host access to it. Storing without the
// permission would give a button that looks live and then fails at the
// injection, so the permission is requested first and nothing is stored if the
// user declines. chrome.permissions.request needs a user gesture, which is why
// this work hangs off the form's submit rather than running on load.

import { normaliseOrigin, permissionPattern } from "./gate.js";
import { readOrigins, writeOrigins } from "./storage.js";

const form = document.querySelector("#add-form");
const input = document.querySelector("#origin-input");
const list = document.querySelector("#origin-list");
const status = document.querySelector("#status");

function say(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function render() {
  const origins = await readOrigins();
  list.replaceChildren();

  if (origins.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing added yet. Auto FDE will not run on any page.";
    list.append(li);
    return;
  }

  for (const origin of origins) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = origin;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", "Remove " + origin);
    remove.addEventListener("click", () => removeOrigin(origin));

    li.append(code, remove);
    list.append(li);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  const origin = normaliseOrigin(input.value);
  if (!origin) {
    say("That is not a host Auto FDE can use. Give an https host, such as foundry.example.com.", true);
    return;
  }

  const origins = await readOrigins();
  if (origins.includes(origin)) {
    say(origin + " is already on the list.");
    input.value = "";
    return;
  }

  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [permissionPattern(origin)] });
  } catch (err) {
    say("Chrome refused the permission request: " + err.message, true);
    return;
  }
  if (!granted) {
    say("Chrome access to " + origin + " was declined, so it has not been added.", true);
    return;
  }

  await writeOrigins([...origins, origin]);
  input.value = "";
  say("Added " + origin + ". Reload any AI FDE tab already open on it.");
  render();
});

async function removeOrigin(origin) {
  const origins = await readOrigins();
  await writeOrigins(origins.filter(o => o !== origin));

  // Handing the host permission back is the point of removing the entry. A
  // refusal is not worth failing over: the origin is gone from the list either
  // way, so the gate already rejects the page.
  try {
    await chrome.permissions.remove({ origins: [permissionPattern(origin)] });
  } catch (err) {
    console.warn("[Auto FDE] could not release host access for " + origin + ":", err);
  }

  say("Removed " + origin + ".");
  render();
}

render();
