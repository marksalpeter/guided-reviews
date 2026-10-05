(function (root, factory) {
  const api = factory();
  root.AYD = Object.assign(root.AYD || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
  function mountCall(container, options = {}) {
    const chip = el("button", "chip");
    chip.type = "button";
    chip.setAttribute("aria-expanded", "false");
    const track = el("span", "chip-track");
    const fill = el("span", "chip-fill");
    track.append(fill);
    const chipLabel = el("span", "chip-label");
    chip.append(track, chipLabel);

    const panel = el("section", "panel");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "are you done");

    const head = el("div", "panel-head");
    const word = el("p", "wordmark");
    word.textContent = "are you done";
    const codeEl = el("p", "meeting-code");
    head.append(word, codeEl);

    const instrument = el("div", "instrument");
    const face = el("div", "ring");
    face.setAttribute("role", "img");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 120 120");
    svg.setAttribute("aria-hidden", "true");
    const trackCircle = circle(60, 60, 52, "ring-track");
    const valueCircle = circle(60, 60, 52, "ring-value");
    const circumference = 2 * Math.PI * 52;
    valueCircle.style.strokeDasharray = String(circumference);
    valueCircle.setAttribute("transform", "rotate(-90 60 60)");
    svg.append(trackCircle, valueCircle);
    const figure = el("p", "ring-figure");
    const num = el("span", "ring-num");
    const unit = el("span", "ring-unit");
    unit.textContent = "%";
    figure.append(num, unit);
    face.append(svg, figure);
    const readout = el("div", "readout");
    const caption = el("p", "caption");
    const allDone = el("p", "all-done");
    allDone.textContent = "Everyone on the call is done.";
    readout.append(caption, allDone);
    instrument.append(face, readout);

    const you = el("div", "you-row");
    const hero = el("div", "hero");
    const listHead = el("h2", "list-head");
    listHead.textContent = "On this call";
    const list = el("ul", "people");
    const syncNote = el("p", "sync-note");
    syncNote.textContent = "The sync server isn’t running, so done won’t be shared.";

    panel.append(head, instrument, you, hero, listHead, list, syncNote);
    container.append(chip, panel);

    let open = false;
    let last = null;
    let listSignature = "";
    let heroSignature = "";
    let saving = false;

    chip.addEventListener("click", () => {
      open = !open;
      applyOpen();
    });

    function applyOpen() {
      panel.hidden = !open;
      chip.setAttribute("aria-expanded", open ? "true" : "false");
      chip.classList.toggle("is-open", open);
    }

    function update(state) {
      last = state;
      const top = Number.isFinite(state.chipTop) ? state.chipTop : 60;
      chip.style.top = `${top}px`;
      panel.style.top = `${top + 48}px`;

      const waiting = state.total <= 0;
      chipLabel.textContent = waiting ? "Waiting for the call" : `${state.doneCount} of ${state.total} done`;
      fill.style.width = `${waiting ? 0 : state.percent}%`;
      chip.setAttribute(
        "aria-label",
        waiting
          ? "Waiting for people on the call. Open the list."
          : `${state.caption}. Open the list.`,
      );

      codeEl.textContent = state.code || "";
      num.textContent = String(waiting ? 0 : state.percent);
      caption.textContent = state.caption || "";
      face.setAttribute("aria-label", waiting ? "0 percent done" : `${state.percent} percent done`);
      valueCircle.style.strokeDashoffset = String(circumference * (1 - (waiting ? 0 : state.percent) / 100));
      instrument.classList.toggle("is-complete", state.total > 0 && state.percent === 100);
      allDone.hidden = !(state.total > 0 && state.percent === 100);
      syncNote.hidden = state.syncOk !== false;

      const heroKey = `${state.self?.id || ""}:${state.self?.done ? 1 : 0}:${state.syncOk === false ? 0 : 1}:${state.saving ? 1 : 0}`;
      if (heroKey !== heroSignature) {
        heroSignature = heroKey;
        paintYou(you, state.self);
        paintHero(hero, state, () => void pressDone());
      }

      const signature = (state.people || [])
        .map((person) => `${person.id}:${person.done ? 1 : 0}:${person.name}:${person.avatarUrl || ""}:${person.self ? 1 : 0}`)
        .join("|");
      if (signature !== listSignature) {
        listSignature = signature;
        list.replaceChildren(...(state.people || []).map(personRow));
      }
      listHead.hidden = !(state.people || []).length;
    }

    async function pressDone() {
      if (saving || !last?.self || last.self.done || last.syncOk === false) return;
      saving = true;
      const current = last;
      update({ ...current, saving: true });
      try {
        await options.onDone?.(current.self);
      } finally {
        saving = false;
        if (last?.saving) update({ ...last, saving: false });
      }
    }

    function setOpen(next) {
      open = Boolean(next);
      applyOpen();
    }

    return {
      update,
      setOpen,
      isOpen: () => open,
      chip,
      panel,
    };
  }

  function paintYou(row, self) {
    row.replaceChildren();
    if (!self) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    row.append(avatar(self, 44), nameBlock(self.name, false));
  }

  function paintHero(hero, state, onDone) {
    hero.replaceChildren();
    const self = state.self;
    if (!self) {
      const missing = el("p", "quiet");
      missing.textContent = "We can’t tell which person on the call is you yet.";
      hero.append(missing);
      return;
    }
    const question = el("h1", self.done ? "question is-done" : "question");
    question.textContent = self.done ? "You’re done." : "Are you done yet?";
    hero.append(question);
    if (self.done) {
      const quiet = el("p", "quiet");
      quiet.textContent = "This call will keep that.";
      hero.append(quiet);
      return;
    }
    const button = el("button", "done-btn");
    button.type = "button";
    button.textContent = state.saving ? "Saving…" : "I’m done";
    button.disabled = state.syncOk === false || Boolean(state.saving);
    button.addEventListener("click", onDone);
    hero.append(button);
  }

  function personRow(person) {
    const item = el("li", person.done ? "person is-done" : "person");
    item.dataset.id = person.id;
    item.dataset.done = person.done ? "1" : "0";
    const status = el("span", "status");
    const dot = el("span", "dot");
    const label = el("span", "status-label");
    label.textContent = person.done ? "Done" : "Not yet";
    status.append(dot, label);
    item.append(avatar(person, 40), nameBlock(person.name, person.self), status);
    return item;
  }

  function nameBlock(name, self) {
    const who = el("div", "who");
    const text = el("span", "person-name");
    text.textContent = name;
    who.append(text);
    if (self) {
      const you = el("span", "you");
      you.textContent = "you";
      who.append(you);
    }
    return who;
  }

  function avatar(person, size) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.alt = "";
    img.width = size;
    img.height = size;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    if (person.avatarUrl) img.src = person.avatarUrl;
    else img.classList.add("is-missing");
    img.addEventListener("error", () => {
      img.removeAttribute("src");
      img.classList.add("is-missing");
    });
    return img;
  }

  function circle(cx, cy, r, className) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    node.setAttribute("cx", String(cx));
    node.setAttribute("cy", String(cy));
    node.setAttribute("r", String(r));
    node.setAttribute("class", className);
    return node;
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  return { mountCall };
});
