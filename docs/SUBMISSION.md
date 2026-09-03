# Devpost submission — copy and paste

Everything below is ready to paste into the WebMCP Challenge submission form at
https://webmcp.devpost.com/. Nothing here needs editing except the video URL,
which has to be filled in after the demo is uploaded to YouTube.

---

## Project name

```
Tallyroom
```

## Elevator pitch (one line)

```
Your bank statement never leaves the browser tab — WebMCP lets the agent come to your data instead of the other way round.
```

## Submission URL (live app)

```
https://pineapplesour.github.io/tallyroom/
```

Judges who want it loaded already: `https://pineapplesour.github.io/tallyroom/?sample`

No login. No credentials to supply.

## Public code repository

```
https://github.com/pineapplesour/tallyroom
```

MIT licence, detectable in the repository's About panel.

## Demo video

```
[ YouTube URL — under 3 minutes, public, with audio narration ]
```

## Built with

```
webmcp, javascript, html, css, svg, es-modules, github-pages, playwright
```

---

## About the project

*(This is the "text description" the rules ask for. It answers the four required
points in order: why WebMCP fits, how it improves the experience, what people and
agents can now do together, and how WebMCP was implemented.)*

### Why this is a strong fit for WebMCP

A cloud agent can only help with your finances if you first hand your finances to
the cloud. A conventional MCP server for bank data has to *receive* the data to
work on it — you upload the statement, or you hand over read access to the
account. Most people, entirely sensibly, will not do that. So the single most
obvious use for a personal assistant is also the one almost nobody uses.

WebMCP inverts the direction of travel. The page holds the data. The page
registers the tools. The agent arrives, calls the tools, and gets back answers —
never rows it did not ask for, and never a file.

**The data does not go to the agent. The agent comes to the data.**

Personal finance is the sharpest case for this, because the sensitivity is
obvious to everyone and the analysis is genuinely valuable. But the pattern
generalises to every category of data people will not upload: medical records,
legal discovery, HR files, unreleased financials.

### How it creates a better experience

Tallyroom is a working money workbench on its own — drop a CSV export from a bank
or card issuer and you get charts, a filterable table, categorisation rules and
budgets, with no account and no upload. WebMCP then makes the same workbench
available to an agent, and three things follow.

**You stop doing the tedious half.** Categorising a year of spending is about a
thousand decisions if you do it row by row. The page clusters the raw description
strings into ~45 merchants, collapsing branch names, card reference numbers and
spelling variants. The agent names those 45 clusters in one pass. The page has
the data and the arithmetic; the model has the judgement.

**The screen and the conversation agree.** `focus_view` is the same code path as
clicking a filter chip. There is no agent-only view of the data. When the agent
says "here are the eight charges I mean", the table in front of you is showing
those eight charges.

**You can see everything it did.** Every tool call lands in an Agent activity
panel with its arguments and its result. The audit trail is not a feature you go
looking for; it is the right-hand column.

### What people and agents can do together that was difficult before

Ask "what am I still paying for, and did anything go up?"

The agent calls `find_recurring`. The page clusters 1,044 transactions into
merchants, tests the gaps between charges for weekly / monthly / quarterly /
yearly regularity, and compares each subscription's early charges against its
recent ones. It returns nine recurring charges with their annualised cost, and
one price rise: Streamly, $15.99 → $18.99, +18.8%. The agent then filters your
screen to those charges and pins the total to the board.

Neither party could have done that alone. A model reading a thousand rows in
context would be slow, expensive and unreliable at the arithmetic — and would
have needed the thousand rows in the first place. The page can compute the
regularity but cannot decide that "VAULTBACK PRO ANNUALSAVE" is a backup service
you forgot about. Twelve months of statement, three tool calls, no upload.

The same split shows up in the anomaly work: the page scores each charge against
its own merchant's median and MAD, finds duplicate charges and unusually large
one-offs; the model decides which of them are worth telling you about and what to
say.

### How WebMCP was implemented

Fifteen tools registered on `document.modelContext` (with `navigator.modelContext`
accepted as a fallback), eight read and seven write, each with a JSON Schema and
full annotations. `openWorldHint: false` is not decoration here — it is literally
true, because no tool on the page can reach the network.

Three implementation decisions are worth calling out.

**Bulk changes are staged, not applied.** An agent cannot recategorise your
statement. `propose_categories` stages the rules, the page renders exactly what
would change and how many rows each rule touches, and a human presses the button.
The dangerous verb was never "read my statement" — it is "silently rewrite a
thousand rows", and that verb is not available to the agent.

**The tool list changes with the state of the page.** While something is staged,
two more tools exist — `apply_staged_changes` and `discard_staged_changes` —
registered at runtime and unregistered via their `AbortSignal` once resolved. The
surface an agent sees is a function of what the page is currently doing.

**Results are capped and summarised**, because context is a scarce resource.
`query_transactions` returns at most 500 rows but its totals always cover every
match, so "how much did I spend on coffee" costs one small result rather than a
thousand rows. Every result is JSON whose first key is a plain-English `summary`.

Two things exist to make the project reviewable. The **egress meter** wraps
`fetch`, `XMLHttpRequest`, `sendBeacon` and `WebSocket` before any application
code runs and *refuses* anything cross-origin or carrying a body, so the privacy
claim is measured rather than promised — the header counter reads `0 bytes sent`
and the test suite asserts it stays there. And because WebMCP is a month old, the
page ships a **spec-shaped compatibility shim** plus an in-page **tool console**
built on `getTools()` / `executeTool()`, so anyone can inspect and drive the
entire tool surface in any browser. The header always says which one is live, so
the shim can never be mistaken for the real thing.

No build step, no framework, no runtime dependencies — plain ES modules and plain
SVG on GitHub Pages. `npm run verify` loads the real page in headless Chromium and
drives all 17 tools through `executeTool()`: 43 assertions, all passing.

---

## Testing notes for judges

- **Nothing to install, no credentials.** Open the live URL and press *Try the
  sample statement*, or use `?sample` to skip the click.
- **The fastest way to review the tool surface** is the *Tool console* button in
  the header. It lists every registered tool, shows the literal description and
  JSON schema a model receives, and runs the tool through
  `document.modelContext.executeTool()`.
- **To see dynamic registration**, run `propose_categories` from the console and
  watch the tool count go from 15 to 17, and the review panel appear. Approve it,
  and it drops back to 15.
- **With a WebMCP browser** (ChatGPT desktop with GPT‑5.6 Sol or Terra, or Chrome
  149+ with `chrome://flags/#enable-webmcp-testing`), the header pill reads
  *WebMCP live* rather than *WebMCP shim*, and the tools are available to the
  browser's own agent.
- **The sample data is synthetic**, generated by `tools/make-sample-data.mjs` from
  a seeded PRNG. Every merchant and person in it is invented, and it contains
  planted findings — a price rise, a forgotten subscription, a duplicate charge, a
  merchant outlier, a travel spike — so the detectors have known right answers.
