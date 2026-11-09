# Moving the game to a studio identity

Goal: the game belongs to a fictional studio, not to you personally. The studio gets its own Google account
(owns the spreadsheets and the server) and its own GitHub account (owns the code and the website).
The new repository starts as a **fresh copy with no history**, so nothing from your personal account carries over.

About an afternoon, most of it waiting for pages to load. Nothing is lost: the old setup keeps running until
the very last step.

Pick the studio name first (e.g. "Lantern Hollow Games"). Below it's written as **Studio**.

---

## 1. Studio Google account
1. In a private/incognito window, create a new Gmail account for Studio (e.g. `lanternhollowgames@gmail.com`).
   Use a strong password kept in a password manager, and turn on **2-Step Verification**
   (myaccount.google.com → Security). Add your personal phone or email only as the recovery option.
2. Use Chrome profiles (or a separate browser) so the Studio account and your personal one never mix.
   Many problems in steps 4–6 come from Google silently picking the wrong account.

## 2. Studio GitHub account
1. In the Studio browser profile, sign up at github.com with the Studio Gmail. Pick a username, e.g. `lanternhollow`.
2. Turn on two-factor authentication (Settings → Password and authentication). Save the recovery codes.
3. Settings → Emails: tick **Keep my email addresses private**, so commits show a GitHub "noreply" address.
4. Create a new repository: **Public**, name `sheets-rpg`, and leave it **completely empty**
   (no README, no licence, no .gitignore).
5. Tell Claude the username. Claude will ask you to connect that GitHub account to Claude (the GitHub connector),
   then pushes the fresh copy as one single commit. Before pushing, Claude removes personal traces:
   personal names in the notes, old spreadsheet ids in `data/import/`, and links to the old repository.
6. Repository → Settings → Pages: Source **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
   The game will be at `https://<studio-username>.github.io/sheets-rpg/` a minute later.
7. GitHub Desktop: File → Options → Accounts → sign out of your personal account, sign in as Studio, then
   Clone the new repository. (Or keep using your personal one for other projects and add Studio as a second
   profile: Desktop supports only one account at a time, so switch when you work on the game.)

## 3. Copy the spreadsheets to the Studio account
Your live data is in the two Google spreadsheets (Game Data and Server). Copies keep every edit you made.
1. In your **personal** account, open each spreadsheet → Share → add the Studio Gmail as **Viewer**.
2. In the **Studio** profile, open each one (from the email or "Shared with me") → File → **Make a copy**.
   Name the copies `Game Data` and `Server`. Studio now owns them.
3. Copy each new spreadsheet's id (the long part of its URL between `/d/` and `/edit`) somewhere handy.

## 4. New server (Apps Script) in the Studio account
1. Studio profile → script.google.com → **New project**. Name it `Sheets RPG server`.
2. Project Settings (gear icon) → **Script properties** → add:
   - `GAME_DATA_ID` = the new Game Data id
   - `SERVER_ID` = the new Server id
   - `EDITOR_KEY` = a new long random password (don't reuse the old one; keep it in your password manager)
3. Project Settings → copy the **Script ID**.

## 5. Let GitHub deploy the server
Same as "Automatic server updates" in `SETUP.md`, but logged in as Studio:
1. On your computer: `npx @google/clasp@2.4.2 login` — the browser opens: **choose the Studio account**.
   Then open the file `.clasprc.json` in your user folder and copy all of it.
2. New repository → Settings → Environments → **New environment** `production` →
   Deployment branches: **Selected branches**, add `main`.
   Add two **environment secrets**: `CLASPRC_JSON` (the whole file) and `SCRIPT_ID` (from step 4.3).
3. Actions → **Deploy server** → Run workflow. It uploads the code, then stops at the deploy step with
   a message that there's no web app yet. That's expected the first time.

## 6. Publish the server and switch the game over
1. In the Apps Script project (refresh it; the code is now there): Deploy → **New deployment** → type **Web app**,
   Execute as **Me**, Who has access **Anyone** → Deploy → allow the permissions (as Studio) → copy the **Web app URL**.
2. Send Claude the URL. Claude updates `client/js/config.js` and the links in the docs, on a branch; you merge it.
   From then on every merge updates the server by itself.
3. Open the new game link, create a character, walk around, open the map editor and save a small change
   (it will ask for the new editor key). Check the change shows in the Studio's Game Data.

Players: characters live in the Server spreadsheet, so they come along with the copy, but each player's browser
remembers its login for the old address. They join again on the new link with the same name (or you hand them
their token from the Players tab).

## 7. Retire the old setup (only after step 6 works)
1. Old Apps Script project (personal account): Deploy → Manage deployments → **Archive** the web app.
2. Old GitHub repo: add a line to the README pointing to the new address, then Settings → **Archive this repository**
   (or delete it if you want no trace; the old site link stops working either way once Pages is off).
3. Personal Google account → myaccount.google.com → Security → **Third-party connections**: remove *clasp* access
   if you ever logged in clasp personally.
4. Optionally stop sharing the old spreadsheets with Studio, and move them to a folder named "old".
5. In Claude: start new chats from the Studio repository (the project notes in `CLAUDE.md` move along with the code).

## Good to know
- Google may show the Studio Gmail as the owner of the server in permission screens; players never see it.
  The GitHub username is what appears in the game's address.
- Commits you make from GitHub Desktop show the Studio name only if Desktop is signed in as Studio
  (check: File → Options → Git, name and email should be Studio's / its noreply address).
- If you later want a real domain (e.g. `lanternhollow.games`), GitHub Pages supports it; ask Claude.
