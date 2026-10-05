# are you done

A Chrome extension for Google Meet. Everyone on the call sees the same thing: who is done, who is not, and how far along the call is. Names and photos come from the Meet itself. There is no login and no email field.

## Run the sync server

The extension needs a small server so browsers in the same Meet can share who has pressed “I’m done”. One machine is enough. Nothing here calls a paid service.

```sh
cd are-you-done/server
npm start
```

That listens on `http://127.0.0.1:8787` and stores meetings in `server/data/rooms.sqlite`. The room key is the Meet code in the URL (`abc-defg-hij`). Refreshing a tab does not wipe the room. Done stays with that person for the meeting code even if their presence heartbeat drops; they leave the live count only when they leave the call.

`npm test` in `server` checks sorting, the meeting-code parser, and the sync API.

## Load the extension unpacked

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select the `are-you-done/extension` folder.
4. Join a Meet. A progress chip sits at the top of the call, in the same slot as Meet’s poll chip. It shows how many people are done out of how many are on the call.
5. Click the chip to open the panel. Not-done people are listed first. The same panel is what everyone with the extension sees.

If the sync server is not on this machine, open the extension’s options and set the server URL. The default is `http://127.0.0.1:8787`. The extension may only talk to localhost unless you add that host under `host_permissions` in `manifest.json`.

## What it reads from Meet

On `https://meet.google.com/*` the content script looks for `data-participant-id` on the tiles, then a display name and photo (`data-self-name`, the image alt text, `notranslate` name nodes, and `aria-label`). Your own tile is the one marked `data-self-name` or “(You)”. If a tile has no participant id, the fallback id is the name plus the avatar URL. The extension never asks who you are.

People on the call are whoever Meet currently has in the DOM. Every couple of seconds your browser tells the sync server you are still here and reads back who has pressed “I’m done”. The chip and the panel both update from that.
