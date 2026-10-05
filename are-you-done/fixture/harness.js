(() => {
  const CODE = "abc-defg-hij";
  const SYNC = "http://127.0.0.1:8787";
  const { scrapeMeet, mergeCall, chipOffset, mountCall } = globalThis.AYD;

  const ui = mountCall(document.querySelector("#overlay"), {
    onDone: () => push("done"),
  });

  function scraped() {
    const result = scrapeMeet(document);
    const people = result.people.map((person) => ({
      ...person,
      avatarUrl: person.avatarUrl ? new URL(person.avatarUrl, location.href).href : "",
    }));
    const self = people.find((person) => person.self) || null;
    return { self, people };
  }

  function paint(doneIds, syncOk) {
    const view = mergeCall(scraped(), doneIds);
    ui.update({
      ...view,
      code: CODE,
      syncOk,
      chipTop: chipOffset(document),
    });
    document.documentElement.dataset.ready = "1";
  }

  async function push(action) {
    const { self } = scraped();
    const url = !self || action === "state" ? `${SYNC}/v1/${CODE}` : `${SYNC}/v1/${CODE}/${action}`;
    const response = await fetch(
      url,
      !self || action === "state"
        ? { cache: "no-store" }
        : {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: self.id,
              name: self.name,
              avatarUrl: self.avatarUrl,
            }),
          },
    );
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    paint(data.doneIds || [], true);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.isOpen()) ui.setOpen(false);
  });

  push("heartbeat").catch(() => paint([], false));
  window.setInterval(() => {
    push("heartbeat").catch(() => paint([], false));
  }, 2000);

  globalThis.__AYD_UI = ui;
})();
