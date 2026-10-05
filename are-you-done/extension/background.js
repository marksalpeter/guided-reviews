const DEFAULT_SYNC = "http://127.0.0.1:8787";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ayd") return;
  handle(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});

async function handle(message) {
  const action = message.action;
  if (!["heartbeat", "done", "leave", "state"].includes(action)) {
    return { ok: false, error: "bad_action" };
  }
  const code = String(message.code || "");
  if (!/^[a-z0-9-]{3,64}$/.test(code)) return { ok: false, error: "bad_meeting" };

  const stored = await chrome.storage.local.get("syncUrl");
  const base = String(stored.syncUrl || DEFAULT_SYNC).replace(/\/$/, "");
  const path = action === "state" ? `${base}/v1/${code}` : `${base}/v1/${code}/${action}`;
  const init =
    action === "state"
      ? { method: "GET", cache: "no-store" }
      : {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message.person || {}),
        };
  const response = await fetch(path, init);
  if (!response.ok) return { ok: false, error: `http_${response.status}` };
  const data = await response.json();
  return { ok: true, doneIds: data.doneIds || [] };
}
