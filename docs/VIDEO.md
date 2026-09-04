# Demo video

A finished video exists: **2:45, 1920×1080, H.264 + AAC, 15.4 MB**, with burned-in
captions. It is not in this repository — it goes to YouTube, and the submission
links to it there.

```
~/tallyroom-video/tallyroom-demo.mp4      (also copied to D:\Downloads\)
~/tallyroom-video/narration.srt           caption sidecar for the YouTube upload
```

**What is left to do:** upload it to YouTube as **Public**, then paste the link
into `docs/SUBMISSION.md` and the Devpost form. That is the only remaining step.

- Title: `Tallyroom — WebMCP Challenge`
- Description: the elevator pitch, the live URL, the repo URL
- Upload `narration.srt` as the English caption track

---

## What the video shows

Every tool call in it is a real `document.modelContext.executeTool()` call made
through the page's own tool console — the mediated path the spec defines for
in-page agents. Nothing is re-enacted and no output is mocked. The narration
says so on camera, at 0:44, so the console is never mistaken for ChatGPT.

| At | Shot | What is on screen |
|---|---|---|
| 0:00 | the problem | The empty state, and the argument for why nobody uploads a bank statement |
| 0:16 | the thesis | The header: WebMCP status, and the egress meter reading zero |
| 0:32 | loading | 1,044 transactions parsed in the browser, counter still at zero |
| 0:48 | the console | `getTools()` / `executeTool()`, and what a model actually receives |
| 0:58 | recurring | `find_recurring` finds nine recurring charges and the Streamly price rise |
| 1:22 | the shared screen | `focus_view` filters the user's table; `pin_insight` leaves a card |
| 1:36 | the approval gate | 32 rules staged, **947 transactions would change**, nothing applied |
| 1:52 | dynamic tools | The tool count goes 15 → 17 while the change set is pending |
| 2:04 | approval | One press; the chart fills with ten real categories |
| 2:09 | anomalies | `find_anomalies` finds the duplicate charge and the travel spike |
| 2:26 | the audit trail | Every call, with arguments and results, in the activity panel |
| 2:36 | the close | Back to the header. Zero bytes sent |

## How it was made

Reproducible from `~/tallyroom-video/`:

| Step | Script | Notes |
|---|---|---|
| narration | `gen_narration.py` | OpenAudio S2 Pro, voice-cloned from a reference recording. English, because the judges are English speakers |
| cut & check | `recut.py` | Whisper large-v3 word timestamps pick the cut point, then score every clip against its script. Average match **0.94** |
| screen capture | `record.mjs` | Playwright drives the live site; each shot is padded to its narration clip and its real position recorded |
| mux | `compose.py` | Lays each clip at its measured shot start, burns ASS captions, scales to 1080p |

Two details worth keeping. The cut point is chosen from a transcript rather than
from silence detection — silence guessed wrong twice out of twelve, once
truncating five seconds of content and once leaving a discarded warm-up sentence
in. And the audio is anchored to the shot positions the recorder actually
measured, not the ones it planned, so a shot that overruns cannot push the rest
of the video out of sync.

## If you want to re-record it with ChatGPT driving

The video is honest as it stands, but a version where ChatGPT's browser calls the
tools would be stronger. To do that: open the live URL in the ChatGPT desktop
app's built-in browser with GPT‑5.6 Sol or Terra, enable *Site tools* under
Settings → Browser → Permissions, and confirm the header pill reads **WebMCP
live**. Then ask, in order:

1. `What am I still paying for every month, and did any of them go up?`
2. `Categorise the merchants I haven't categorised yet.`
3. `Anything in here worth a second look?`

The same narration script (`~/tallyroom-video/script/*.txt`) still applies, with
one edit: the line at 0:44 about the page's own console should become a line
about ChatGPT calling the tools.
