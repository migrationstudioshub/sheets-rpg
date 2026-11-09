# Setup

Two parts: **GitHub Pages** serves the game page, editor and art (step 1), and an
**Apps Script web app** is the server that checks moves and saves players
(steps 2–7). Until step 7 is done, the game runs in **offline mode**: same maps
and rules, with progress kept in your browser.

## 1. Turn on GitHub Pages (2 minutes)

1. On GitHub, open the repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, **Branch** to `main` and folder `/ (root)`, then **Save**.
3. After a minute the game is at **https://migrationstudioshub.github.io/sheets-rpg/** (offline mode).

## 2. Import the two spreadsheets

1. Go to [sheets.new](https://sheets.new) → **File → Import → Upload** → pick `data/GameData.xlsx` from the repository → **Replace spreadsheet** → **Import data**. Rename it **Game Data**.
2. Do the same with `data/Server.xlsx` in a second new spreadsheet and name it **Server**.
3. From each spreadsheet's address bar, copy its id: the long part between `/d/` and `/edit`.

These replace the old Editor, Server and Client spreadsheets. Keep the old ones as a backup; nothing reads them any more.

## 3. Create the server project

1. Go to [script.google.com](https://script.google.com) → **New project**. Name it **Sheets RPG server**.
2. Click the gear (**Project Settings**) → tick **Show "appsscript.json" manifest file in editor**.
3. Back in the editor (**< >**), replace the contents of `appsscript.json` with `server/appsscript.json` from the repository.
4. Replace the contents of `Code.gs` with `server/Code.js`.
5. Click **+ → Script** four times to add `shared_content`, `shared_autotile`, `shared_rules` and `shared_world`, and paste the matching files from `server/` into each. (Every `server/shared_*.js` file must be in the project; if the game says something like "World is not defined", one is missing.)
6. Save (Ctrl+S).

## 4. Tell the server where the spreadsheets are

**Project Settings → Script properties → Add script property**, twice:

| Property | Value |
| --- | --- |
| `GAME_DATA_ID` | the Game Data id from step 2 |
| `SERVER_ID` | the Server id from step 2 |
| `EDITOR_KEY` | a password of your choice; the map editor asks for it the first time you save |

## 5. Check it

In the editor, pick **checkSetup** in the function menu → **Run**. Google asks for permission the first time: **Review permissions** → your account → **Advanced** → **Go to Sheets RPG server (unsafe)** → **Allow**. ("Unsafe" only means Google hasn't reviewed your own script.) The log should end with *Setup looks good.*

## 6. Publish the web app

**Deploy → New deployment** → gear → **Web app**:

- **Execute as:** Me
- **Who has access:** Anyone

**Deploy**, then copy the **Web app URL** (it ends in `/exec`).

## 7. Connect the game to the server

Send the `/exec` URL to Claude, or put it in `client/js/config.js` yourself:

```js
API_URL: 'https://script.google.com/macros/s/…/exec',
```

Once that's pushed, the game page says **online**, and characters are saved in the Server spreadsheet's Players tab.

## Automatic server updates (one-time, ~10 minutes)

Once this is set up, every merged change to server code updates Apps Script by itself: GitHub runs the tests,
uploads the files and publishes a new version under the same URL. No more pasting files.

1. **Allow tools to update your scripts:** open [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
   and switch **Google Apps Script API** to **On**.
2. **Install Node.js** (the "LTS" version) from [nodejs.org](https://nodejs.org) if you don't have it. Default options are fine.
3. **Sign in once:** open **Command Prompt** (Windows key, type `cmd`) and run:
   ```
   npx @google/clasp@2.4.2 login
   ```
   Answer `y` if it asks to install. A browser page opens: choose the Google account that owns the server project and click
   **Allow**. The command prompt then says you're logged in.
4. **Copy the login file:** in the same window run `notepad %USERPROFILE%\.clasprc.json`, select everything (Ctrl+A) and copy it.
5. **Make a locked place for the secrets:** in the repository, **Settings → Environments → New environment**, name it
   `production`, **Configure environment**. Under **Deployment branches and tags** choose **Selected branches and tags →
   Add deployment branch or tag rule**, type `main`, **Add rule**. Only merged code (the `main` branch) can now use what's
   stored here; a workflow on any other branch can't read it.
6. **Add the two secrets there:** on the same page, **Environment secrets → Add environment secret**:
   - Name `CLASPRC_JSON`, Value: paste the login file you copied.
   - Name `SCRIPT_ID`, Value: in Apps Script, **Project Settings (⚙️) → IDs → Script ID → Copy**, then paste.

   (Use *environment* secrets, not repository secrets — repository secrets are readable from any branch.)
7. **Try it:** on GitHub, **Actions → Deploy server → Run workflow → Run workflow**. After a minute it turns green ✓.
   If it turns red, open it: the failing step says why.

From then on: merging a pull request that changes `server/` or `shared/` deploys automatically; check the **Actions**
tab if you want to see it (GitHub emails you if a deploy fails). Don't edit code in the Apps Script editor any more —
the next deploy replaces it with the repository's version. (Script properties, triggers and the spreadsheets are not touched.)

**About the secret:** it is a sign-in for Google's Apps Script tool (clasp) on your account. GitHub keeps secrets encrypted,
never prints them in logs, and doesn't give them to people who copy (fork) the repository. To revoke it at any time:
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) → remove the clasp / Apps Script entry.

## Map editor

**https://migrationstudioshub.github.io/sheets-rpg/editor/** (shortcuts are listed in its right panel when nothing is selected).

- **Before step 7 (offline):** *Save draft* keeps your edits in this browser, and the game plays that draft automatically (*Play-test* opens it on the current map). *Export* downloads `tables.json`; put it in the repository's `data/` folder and commit it to make the edits permanent and visible to everyone. *Discard draft* goes back to the repository's data.
- **After step 7 (online):** *Save to Game Data* writes maps and definitions straight into the spreadsheet, and players see them on their next reload.

## Day to day

- **After an update that adds new tabs or columns to Game Data:** don't re-import `GameData.xlsx` once you've edited your spreadsheet — it would replace your edits. Updates say exactly which tabs, columns or rows to add by hand, and the game works with sensible defaults until you do. The server adds new columns to the Server spreadsheet's Players tab by itself.

- **Edited Game Data by hand in the spreadsheet?** Open `<your /exec URL>?action=reload` once so the server picks up the changes (otherwise it updates within 6 hours). Saving from the map editor does this for you.
- **Server code changed in the repository?** With automatic updates set up (above), nothing to do. Without them: paste the changed `server/` files into the project, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.
