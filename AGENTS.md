# Working on this repo

## Screenshots

**A commit that changes the panel's UI re-renders the screenshots in the same commit.**
The README leads with them, so a stale screenshot is a stale README. Any new screenshot
goes into the README too — an image nothing links to is dead weight.

```sh
npm run build:webview
npx tsx scripts/demo.ts          # scripts/payload.json, the fixture review — needs the claude CLI
node scripts/shoot.mjs           # media/screenshot-dark.png, media/screenshot-light.png
node scripts/shot-scrolled.mjs   # media/screenshot-sticky.png
node scripts/shot-loading.mjs    # media/screenshot-loading.png
```

`scripts/payload.json` is gitignored. Regenerate it only when it is missing or the
fixture itself changes; the three shooters read whatever is already there.
