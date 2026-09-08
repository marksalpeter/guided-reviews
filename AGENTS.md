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

## Verifying a UI change

**Look at the change before calling it done.** Screenshot the states it touches, read the
images, and fix what you see — the shooters take a `clip` and a `deviceScaleFactor`, so a
detail worth arguing about can be inspected at 6-10x:

```js
const page = await browser.newPage({ viewport: { width: 640, height: 760 }, deviceScaleFactor: 6 })
await page.screenshot({ path: out, clip: { x, y, width, height } })
```

Copy a shooter to a scratch file, change the viewport, mode, or clip, and delete it after —
`let s={mode:'diff'}` in the harness opens the unguided view, and a viewport under 900px
crosses the one-column breakpoint. The states worth a look for anything in the shell: wide
and narrow, guided and unguided, dark and light. A rule that reads correctly can still land
wrong: check that the selector you wrote is the one that wins, and at the width the user
actually runs.

## Reinstalling

**"Reinstall" means build, package, and install the VSIX — then ask the user to reload.**
The editor runs the installed copy, so `npm run build` alone changes nothing they can see.

```sh
npm run package                                       # builds, then writes guided-reviews-<version>.vsix
code --install-extension guided-reviews-<version>.vsix --force
```

`npm run package` runs the build itself, so there is no separate build step. `--force` is
required: the version rarely changes between installs, and without it VS Code skips an
install it reads as already present.

Finish by telling the user to run **Developer: Reload Window** and reopen the panel. No
agent can trigger that from the shell — the extension host holds the old copy until the
window reloads — so the work is not done until they have been asked.
