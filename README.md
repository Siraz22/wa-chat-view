# Chat Restore

A WhatsApp export viewer that runs entirely in the browser. Open a `.zip` exported
from WhatsApp (or just the `.txt`) and read the conversation back with its photos,
videos and voice notes, laid out the way WhatsApp lays it out.

**No server, no upload, no account.** The file is read locally by the page; nothing
is ever sent anywhere. That is what makes it safe to hand to someone else for a
private chat, and why hosting costs nothing no matter how big the export is.

## Run it

Double-click `index.html`, or serve the folder:

    python3 -m http.server 8000     # then open http://localhost:8000

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

## Notes

- Media is matched to messages by filename, so keep the export intact.
- `.opus` voice notes play in Chrome and Firefox; Safari may refuse them and shows a
  download chip instead. Same for `.heic` photos on non-Apple browsers.
- Only ~1600 message rows live in the DOM at once; earlier ones load as you scroll up.
- "Show as me" in the ⋮ menu picks whose messages sit on the right.
