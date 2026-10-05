(function (root, factory) {
  const api = factory();
  root.AYD = Object.assign(root.AYD || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
  const BLOCKED = new Set(["new", "landing", "_meet", "about", "getalink", "unsupported"]);

  function meetingCodeFromLocation(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.hostname !== "meet.google.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const raw = parts[0] === "lookup" ? parts[1] : parts.length === 1 ? parts[0] : "";
    if (!raw) return null;
    const code = raw.toLowerCase();
    if (!/^[a-z0-9-]{3,64}$/.test(code) || BLOCKED.has(code)) return null;
    return code;
  }

  function sortPeople(people) {
    return [...people].sort((a, b) => {
      if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }

  function percentDone(doneCount, total) {
    if (total <= 0) return 0;
    return Math.round((doneCount / total) * 100);
  }

  function caption(doneCount, total) {
    if (total <= 0) return "No one is on the call yet.";
    const verb = doneCount === 1 ? "is" : "are";
    return `${doneCount} of ${total} ${verb} done`;
  }

  function mergeCall(scraped, doneIds) {
    const done = new Set(doneIds || []);
    const people = sortPeople(
      (scraped.people || []).map((person) => ({
        ...person,
        done: done.has(person.id),
      })),
    );
    const doneCount = people.filter((person) => person.done).length;
    const total = people.length;
    const self = people.find((person) => person.self) || null;
    return {
      self,
      people,
      doneCount,
      total,
      percent: percentDone(doneCount, total),
      caption: caption(doneCount, total),
    };
  }

  function chipOffset(doc) {
    const bar = doc.querySelector("[data-ayd-callbar], [role='banner']");
    if (!bar || typeof bar.getBoundingClientRect !== "function") return 60;
    const bottom = bar.getBoundingClientRect().bottom;
    if (bottom > 24 && bottom < 180) return Math.round(bottom + 8);
    return 60;
  }

  return {
    meetingCodeFromLocation,
    sortPeople,
    percentDone,
    caption,
    mergeCall,
    chipOffset,
  };
});
