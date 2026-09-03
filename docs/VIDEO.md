# Demo video — shot list and narration

**Hard requirements from the rules:** public YouTube link, **under 3 minutes**,
audio narration, shows the project working and explains how WebMCP was used. No
unlicensed third-party music or footage — narration over a screen recording is
enough, and is what the rules describe.

Target length **2:40**. Record at 1440×900 or larger, browser zoom 100%.

---

## Before you record

1. Open `https://pineapplesour.github.io/tallyroom/` — **do not** load the sample
   yet. The empty state is the opening shot.
2. Set the browser to light mode and make the window clean (no bookmarks bar, no
   extensions sidebar).
3. Decide which path you are recording:
   - **Path A (preferred).** ChatGPT desktop app, built-in browser, model set to
     GPT‑5.6 Sol or Terra, Settings → Browser → Permissions → *Enable site tools*.
     The header pill will read **WebMCP live**.
   - **Path B (fallback).** Any browser. The header pill reads **WebMCP shim**,
     and you drive the tools from the built-in **Tool console**. This is still a
     truthful demo — say the words "compatibility shim" once, on camera, so
     nobody is misled.
4. If recording Path A, have these three prompts ready to paste:
   - `What am I still paying for every month, and did any of them go up?`
   - `Categorise the merchants I haven't categorised yet.`
   - `Anything in here worth a second look?`

---

## Shot list

### 0:00 – 0:22 · The problem

**On screen:** the empty state. Cursor rests on the `0 bytes sent` counter.

> "If you want an AI to look at your spending, you normally have to upload your
> bank statement first. Almost nobody wants to do that — so the most obvious use
> for an assistant is the one nobody uses.
>
> This is Tallyroom. It's a money workbench that runs entirely in the tab. And
> because of WebMCP, an agent can use it without the data ever leaving my browser."

### 0:22 – 0:40 · Load it

**On screen:** click *Try the sample statement*. Charts and the table appear.
Point at the header counter, still reading zero.

> "Here's a year of statement — a thousand transactions, invented for the demo.
> It parsed in the browser. Nothing was uploaded, and that counter in the header
> is measuring that, not just claiming it. Every outbound request from this page
> is blocked."

### 0:40 – 1:15 · The subscriptions question — the headline moment

**Path A:** ask in ChatGPT: *What am I still paying for every month, and did any
of them go up?*
**Path B:** open the Tool console, run `find_recurring`, then `focus_view`.

**On screen:** the Agent activity panel filling in on the right; the table
filtering itself; a pinned card landing on the board.

> "I'll ask what I'm still paying for.
>
> It calls `find_recurring`. The page clusters a thousand rows into merchants,
> tests the gaps between charges for a monthly rhythm, and compares the early
> charges against the recent ones. Nine subscriptions, twenty-five thousand
> dollars a year — and one price rise I never noticed: fifteen ninety-nine to
> eighteen ninety-nine.
>
> Then it filters *my* screen to those charges. The conversation and the screen
> are looking at the same thing, because the tool that filters the table is the
> same code path as clicking a filter chip."

### 1:15 – 1:50 · The approval gate — the trust moment

**Path A:** ask *Categorise the merchants I haven't categorised yet.*
**Path B:** run `propose_categories` from the console.

**On screen:** the amber review panel appears listing rules and row counts. Then
open the Tool console and show the tool count going from 15 to 17.

> "Now something riskier: categorise the whole year.
>
> It can't. `propose_categories` only *stages* the change. The page shows me every
> rule and exactly how many rows it would touch, and I press the button — not the
> agent.
>
> And look at the tool list while that's pending: it grew from fifteen tools to
> seventeen. `apply_staged_changes` and `discard_staged_changes` are registered at
> runtime and unregistered the moment I decide. The surface the agent sees depends
> on what the page is currently doing."

**On screen:** click *Apply all rules*. The Uncategorised bar collapses; real
categories fill the chart.

> "One press, and a thousand rows are categorised."

### 1:50 – 2:15 · Anomalies

**Path A:** ask *Anything in here worth a second look?*
**Path B:** run `find_anomalies`.

**On screen:** the flagged rows; a pinned insight card.

> "Same division of labour for the odd ones out. The page scores every charge
> against that merchant's own median, so one huge charge can't hide another. It
> finds the same hundred-and-twenty-eight dollars billed twice on one day, a
> four-hundred-dollar grocery run at a shop where sixty is normal, and a travel
> week that dwarfs everything around it.
>
> The page does the arithmetic. The model decides which of it I actually need to
> hear about."

### 2:15 – 2:40 · The point

**On screen:** scroll the Agent activity panel from top to bottom. End on the
header with the counter still at zero.

> "Every call it made is here, with the arguments and the result. There's no path
> to my data that doesn't appear in this column.
>
> A normal MCP server would have had to receive my bank statement to do any of
> this. WebMCP turned that around: the data stayed put and the agent came to it.
> That's the part I think generalises — to medical records, to legal files, to
> anything people won't upload.
>
> Zero bytes sent. Code's on GitHub under MIT."

---

## After recording

1. Trim to under 3:00. **Check the duration before uploading** — over-length is a
   disqualification risk.
2. Upload to YouTube as **Public** (not Unlisted — the rules ask for a public
   video).
3. Title: `Tallyroom — WebMCP Challenge` · Description: paste the elevator pitch,
   the live URL and the repo URL.
4. Put the YouTube link into `docs/SUBMISSION.md` and into the Devpost form.
