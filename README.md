# AI Scraper Kit

**Give your AI agent the internet.** One link sets up a complete web-scraping toolkit for
**Claude Code** or **Codex**: free tools first, three paid services on their free plans as backup,
and an AI that tells you what a job will cost *before* it spends anything.

> **To install, paste this to your AI agent (Claude Code or Codex):**
>
> `Set up https://github.com/wald21x6-ops/ai-scraper-kit for me`

It takes about five minutes. Your part is making three free accounts and pasting three keys.

---

## 🤖 For the AI agent doing the install

You are installing this for the user. Do every step yourself; only the sign-ups and the key pasting are theirs.
Keep your messages short and plain — the user may not be technical. Paths below use `~/scraper-kit`
(Git Bash, macOS, Linux); in PowerShell write `$HOMEscraper-kit`, in cmd.exe `%USERPROFILE%scraper-kit`.

1. **Node 22 or newer.** Run `node --version`. If it is missing or older, ask the user, then install it:
   Windows `winget install OpenJS.NodeJS.LTS` · Mac `brew install node` · otherwise send them to https://nodejs.org.
   If `node` is still not found afterwards, call it by its full path for the rest of the install:
   Windows `"C:Program Files
odejs
ode.exe"` · Mac `/opt/homebrew/bin/node` (Apple silicon) or `/usr/local/bin/node`.
2. **Get the kit** into a folder called `scraper-kit` in the user's home folder:
   - already there → `git -C ~/scraper-kit pull`
   - otherwise → `git clone https://github.com/wald21x6-ops/ai-scraper-kit ~/scraper-kit`
   - no git → download https://github.com/wald21x6-ops/ai-scraper-kit/archive/refs/heads/main.zip, unzip it,
     and rename the folder inside (`ai-scraper-kit-main`) to `scraper-kit` in the home folder, so that
     `~/scraper-kit/scrape.mjs` exists. (A zip copy updates by downloading it again; `update` needs git.)
3. **Run setup:** `node ~/scraper-kit/scrape.mjs setup`
   It creates the keys file, opens it in Notepad (Windows) or TextEdit (Mac), teaches Claude Code and/or
   Codex about the kit (see "What setup changes" below), and prints three sign-up links.
4. **Hand over to the user.** Show them the three links from the output and say: make a free account on each
   (no card needed), copy the API key, paste it after its `=` in the open file, save, and say "done".
   If the file did not open, give them the path setup printed, or run `node ~/scraper-kit/scrape.mjs keys`.
   Never ask them to paste a key into the chat.
5. **When they say done:** run `node ~/scraper-kit/scrape.mjs check`. Tell them in plain words what works and
   how much free credit each service has. A service still showing "no key yet" was skipped or not saved — say
   which, and that it's fine to add later. If a key "could not be confirmed", ask them to re-copy that one
   (`keys` reopens the file) and check again.
6. **Finish:** tell them to start a new chat so the AI picks up the new skill, and that from now on they can
   just ask for anything from the web — plus "check my scraper" and "update my scraper" work any time.

### What setup changes on the computer

- `~/scraper-kit/data/keys.env` — the keys file (plus budget, history and site memory in the same `data` folder).
- For each AI it finds (it looks for `~/.claude` or a `claude` command, and `~/.codex` or a `codex` command):
  - **Claude Code:** a skill at `~/.claude/skills/scraper-kit/`, and a short block at the end of `~/.claude/CLAUDE.md`.
  - **Codex:** a skill at `~/.agents/skills/scraper-kit/`, and the same block at the end of `~/.codex/AGENTS.md`
    (or `$CODEX_HOME/AGENTS.md`).
  - The block sits between `<!-- scraper-kit:start -->` and `<!-- scraper-kit:end -->`. Re-running setup
    replaces it; `uninstall` removes exactly it and the skill folders. Nothing else in those files is touched.
- Force a choice with `setup --claude` or `setup --codex`; `--no-open` skips opening the keys file.

---

## What you get

| Tool | Cost | What it's for |
|---|---|---|
| Plain fetch | free | normal web pages |
| Your own Chrome / Edge | free | pages that need JavaScript, Facebook pages, the Meta Ad Library |
| [Firecrawl](https://www.firecrawl.dev) | free 1,000 credits / month, no card | hard-to-reach pages, web search, whole-site crawls |
| [Apify](https://apify.com) | free $5 / month, no card | ready-made scrapers: Google Maps, Instagram, TikTok, LinkedIn, Facebook ads, Amazon… |
| [ScrapeGraph](https://scrapegraphai.com) | free 500 credits, one time | the last backup for pages and search |

- **Free first, always.** The paid services are only touched when the free tools fail.
- **Asks before spending.** Nothing paid runs until you agree to a specific cost, like
  *"about $1.40 of your $4.99 Apify credit — go ahead?"*
- **Never over the free plans.** Limits are set to each free allowance and checked against each service's own numbers.
- **Remembers websites.** A site that blocked a tool is remembered, so the next run goes straight to what works.
- **Nothing to install** beyond Node: no Python, no packages, no browser download.
- **Windows and Mac.**

## Everyday use

Just ask your AI for things: *"find 50 dentists in Austin with their phone numbers"*, *"what are my
competitors charging?"*, *"what ads is this company running on Facebook?"*. It picks the tool, tells you the
cost if there is one, and waits for your yes.

You can also say **"check my scraper"** (what works, credits left) or **"update my scraper"**.

## Privacy

Your keys live in `scraper-kit/data/keys.env` on your computer. That folder is never uploaded — it is
excluded from git. The kit only talks to the three services you gave keys to, and to the websites you ask about.
Besides its own folder, it adds one skill and one short marked block to your AI's instructions
(see "What setup changes" above).

## Remove it

`node ~/scraper-kit/scrape.mjs uninstall` removes the skill and the marked block from your AI's instructions.
Delete the `scraper-kit` folder to remove everything, keys included.

---

Made by [Frontdesk Revenue](https://frontdeskrevenue.in) · MIT licence
