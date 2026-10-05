(function (root, factory) {
  const api = factory();
  root.AYD = Object.assign(root.AYD || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
  const NOISE =
    /^(mute|unmute|camera|mic|microphone|present now|present|pin|unpin|more options|more|audio|video|leave call|raise hand|you|people|chat|activities)$/i;

  function cleanName(raw) {
    if (!raw) return "";
    return String(raw)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*\(you\)\s*$/i, "")
      .replace(/^participant:\s*/i, "")
      .trim();
  }

  function usableName(name) {
    if (!name || name.length > 80 || NOISE.test(name)) return "";
    return name;
  }

  function fallbackId(name, avatarUrl) {
    return `name:${name.trim().toLowerCase()}|${avatarUrl || ""}`;
  }

  function scoreImage(img) {
    const src = img.currentSrc || img.getAttribute("src") || "";
    let score = 0;
    if (/googleusercontent|ggpht|google\.com\/a\//.test(src)) score += 5;
    const width = img.naturalWidth || Number(img.getAttribute("width")) || img.width || 0;
    if (width >= 32) score += 3;
    if (width > 0 && width <= 20) score -= 5;
    if (usableName(cleanName(img.getAttribute("alt")))) score += 2;
    return score;
  }

  function avatarFrom(el) {
    const images = [...el.querySelectorAll("img")];
    let best = "";
    let bestScore = -1;
    for (const img of images) {
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!/^(https?:|blob:|data:image\/)/i.test(src)) continue;
      const score = scoreImage(img);
      if (score > bestScore) {
        best = src;
        bestScore = score;
      }
    }
    return best;
  }

  function nameFrom(el) {
    const own = usableName(cleanName(el.getAttribute("data-self-name")));
    if (own) return own;
    const nested = el.querySelector("[data-self-name]");
    if (nested) {
      const fromNested = usableName(
        cleanName(nested.getAttribute("data-self-name") || nested.textContent),
      );
      if (fromNested) return fromNested;
    }
    const fromAlt = usableName(cleanName(el.querySelector("img[alt]")?.getAttribute("alt")));
    if (fromAlt) return fromAlt;
    const heading = el.querySelector("[role='heading'], .notranslate");
    if (heading) {
      const fromHeading = usableName(cleanName(heading.textContent));
      if (fromHeading) return fromHeading;
    }
    const fromAria = usableName(cleanName(el.getAttribute("aria-label")));
    if (fromAria) return fromAria;
    return "";
  }

  function isSelf(el, name) {
    if (el.hasAttribute("data-self-name") || el.querySelector("[data-self-name]")) return true;
    const blob = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""} ${name}`;
    return /\(you\)/i.test(blob);
  }

  function remember(map, person) {
    const prev = map.get(person.id);
    if (!prev) {
      map.set(person.id, person);
      return;
    }
    if (!prev.name && person.name) prev.name = person.name;
    if (!prev.avatarUrl && person.avatarUrl) prev.avatarUrl = person.avatarUrl;
    if (person.self) prev.self = true;
  }

  function scrapeMeet(doc) {
    const map = new Map();
    for (const el of doc.querySelectorAll("[data-participant-id]")) {
      const id = (el.getAttribute("data-participant-id") || "").trim();
      if (!id) continue;
      const name = nameFrom(el);
      if (!name) continue;
      remember(map, {
        id,
        name,
        avatarUrl: avatarFrom(el),
        self: isSelf(el, name),
      });
    }

    if (map.size === 0) {
      const nodes = doc.querySelectorAll("[data-self-name], [role='listitem']");
      for (const el of nodes) {
        const name = nameFrom(el);
        if (!name) continue;
        const avatarUrl = avatarFrom(el);
        remember(map, {
          id: fallbackId(name, avatarUrl),
          name,
          avatarUrl,
          self: isSelf(el, name),
        });
      }
    }

    const people = [...map.values()];
    const self = people.find((person) => person.self) || null;
    return { self, people };
  }

  return { cleanName, usableName, fallbackId, scrapeMeet };
});
