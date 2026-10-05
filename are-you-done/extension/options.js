const input = document.querySelector("#syncUrl");
const saved = document.querySelector("#saved");

chrome.storage.local.get("syncUrl", (stored) => {
  if (stored.syncUrl) input.value = stored.syncUrl;
});

document.querySelector("#form").addEventListener("submit", (event) => {
  event.preventDefault();
  const syncUrl = input.value.trim().replace(/\/$/, "");
  chrome.storage.local.set({ syncUrl }, () => {
    saved.textContent = "Saved.";
  });
});
