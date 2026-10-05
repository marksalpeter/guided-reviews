(() => {
  if (globalThis.__AYD_MOUNTED) return;
  globalThis.__AYD_MOUNTED = true;

  const { meetingCodeFromLocation, scrapeMeet, mergeCall, chipOffset, mountCall } = globalThis.AYD;

  const host = document.createElement("div");
  host.id = "ayd-root";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  shadow.append(style);
  document.documentElement.append(host);

  let doneIds = [];
  let syncOk = true;
  let selfPerson = null;
  let disposed = false;
  let syncing = false;

  const ui = mountCall(shadow, {
    onDone: () => sync("done"),
  });

  fetch(chrome.runtime.getURL("panel.css"))
    .then((response) => response.text())
    .then((css) => {
      const fonts = chrome.runtime.getURL("fonts/");
      style.textContent = css.replaceAll('url("fonts/', `url("${fonts}`);
    })
    .catch(() => {});

  function send(action, code, person) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ayd", action, code, person }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });
  }

  function paint() {
    const code = meetingCodeFromLocation(location.href);
    if (!code) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const view = mergeCall(scrapeMeet(document), doneIds);
    selfPerson = view.self;
    ui.update({
      ...view,
      code,
      syncOk,
      chipTop: chipOffset(document),
    });
  }

  async function sync(action) {
    const code = meetingCodeFromLocation(location.href);
    if (!code || disposed) return;
    const self = scrapeMeet(document).self;
    let response;
    if ((action === "heartbeat" || action === "done") && self) {
      response = await send(action, code, {
        id: self.id,
        name: self.name,
        avatarUrl: self.avatarUrl,
      });
    } else if (action === "leave" && selfPerson) {
      response = await send("leave", code, { id: selfPerson.id });
    } else {
      response = await send("state", code);
    }
    if (disposed) return;
    if (response?.ok && action !== "leave") {
      doneIds = response.doneIds || [];
      syncOk = true;
    } else if (!response?.ok && action !== "leave") {
      syncOk = false;
    }
    paint();
  }

  async function refresh() {
    if (syncing || disposed) return;
    syncing = true;
    try {
      await sync("heartbeat");
    } finally {
      syncing = false;
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.isOpen()) {
      ui.setOpen(false);
      ui.chip.focus();
    }
  });

  window.addEventListener("pagehide", () => {
    const code = meetingCodeFromLocation(location.href);
    if (!code || !selfPerson) return;
    chrome.runtime.sendMessage({
      type: "ayd",
      action: "leave",
      code,
      person: { id: selfPerson.id },
    });
  });

  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  history.pushState = (...args) => {
    const result = pushState(...args);
    paint();
    void refresh();
    return result;
  };
  history.replaceState = (...args) => {
    const result = replaceState(...args);
    paint();
    void refresh();
    return result;
  };
  window.addEventListener("popstate", () => {
    paint();
    void refresh();
  });

  let domTimer = 0;
  const observer = new MutationObserver(() => {
    window.clearTimeout(domTimer);
    domTimer = window.setTimeout(paint, 250);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-participant-id", "data-self-name"],
  });

  window.setInterval(() => {
    void refresh();
  }, 2000);

  paint();
  void refresh();
})();
