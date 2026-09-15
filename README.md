# Chat Restore

A WhatsApp export viewer that runs entirely in the browser. Open a `.zip` exported
from WhatsApp (or just the `.txt`) and read the conversation back with its photos,
videos and voice notes, laid out the way WhatsApp lays it out.

**Reading happens entirely in the browser.** Messages, photos and voice notes are
decoded locally — none of that is uploaded, so hosting costs nothing no matter how
big the export is.

**The chat `.txt` is also shared.** When you open an export, its text is appended to
a common Supabase table so the four of us build one shared pile of notes. Nothing
records who shared what — only the content matters. Media is
never uploaded, and the page cannot read the pile back — the publishable key grants
`INSERT` and nothing else. Read the pile in the Supabase Table Editor (a separate
viewer project is planned).

Sharing is silent either way — nothing on screen, success or failure. Check the
Supabase table to see what landed (see `read-notes.sql`); if an export is missing,
drop it again. Failures are logged to the browser console.

Re-dropping the same export does nothing: each chunk carries a SHA-256 of the file
and a unique index turns a repeat into a no-op. The database is the only judge of
that — the browser keeps no list of what it has sent, so deleting rows in the
dashboard really does let the same export be uploaded again. That also means a share interrupted
half way finishes if you simply drop the file again. Failures are logged to the
browser console.

## Run it

Double-click `index.html`, or serve the folder:

    python3 -m http.server 8000     # then open http://localhost:8000

Reading works from anywhere. Sharing is happiest on `https://` or `localhost`,
which is what GitHub Pages gives you — over a plain `http://` LAN address the
browser withholds `crypto.subtle`, and the uploader falls back to hashing in JS.

## Put it online (free)

It is four static files, so any static host works — drag the folder onto
[netlify.com/drop](https://app.netlify.com/drop), or push to GitHub and turn on
GitHub Pages. Only the viewer gets hosted; chat data never reaches the host.

## Files

| file | what it does |
|---|---|
| `index.html` | markup and layout |
| `styles.css` | WhatsApp-ish theme, light + dark |
| `zip.js` | random-access ZIP reader (no dependencies). Reads the central directory by slicing the tail of the file and inflates one entry at a time with `DecompressionStream`, so a multi-GB export never loads into memory. Handles ZIP64. |
| `parser.js` | parses the export `.txt`: Android and iOS layouts, 12h/24h clocks, `dd/mm` vs `mm/dd` inferred across the whole file, multi-line messages, system messages, attachment markers |
| `app.js` | rendering, windowed scrolling, media hydration, search, date jump |
| `uploader.js` | chunks the chat `.txt` and appends it to Supabase (write-only) |
| `config.js` | Supabase URL + publishable key (safe to commit) |
| `supabase-migration.sql` | adds the `content_hash` column and dedupe index |

## Notes

- Media is matched to messages by filename, so keep the export intact.
- `.opus` voice notes play in Chrome and Firefox; Safari may refuse them and shows a
  download chip instead. Same for `.heic` photos on non-Apple browsers.
- Only ~1600 message rows live in the DOM at once; earlier ones load as you scroll up.
- "Show as me" in the ⋮ menu picks whose messages sit on the right.

## Sharing setup

The table lives in the Appender project's Supabase database (EU / Frankfurt). Run
`supabase-migration.sql` in the SQL Editor once, then `config.js` is already filled in.

To turn sharing off entirely, delete `config.js` — the reader keeps working locally
and the share chip never appears.
