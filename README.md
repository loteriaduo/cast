# Lotería Duo — Cast receiver (TV page)

The page a Chromecast / Google TV loads when the Lotería Duo app casts. The phone runs the game;
this page only shows it. Static files, no build step. See `docs/cast-to-tv-plan.md` for the full plan.

## Preview in a browser
Serve this folder (e.g. `python3 -m http.server` from the repo root) and open:
- `cast-receiver/` — idle screen ("Open Lotería Duo on your phone…")
- `cast-receiver/?demo` — a Classic game in progress. Options: `n=8` cards called, `lang=en`,
  `layout=card-board|card|board` (`card` = card + called cards, newest first), `names=es|en|both`, `status=ready|playing|paused|ended|winner`, `auto` (calls a card every 4 s).
  In the console: `demo.next()`, `demo.status('paused')`, `demo.layout('card')`, `demo.offline()`, `demo.tie('pick'|'reveal'|'done', players)` / `demo.tie(null)`.
- `cast-receiver/?test` — exposes `window.ldReceiver.handle(msg)` to feed protocol messages by hand.

## Message protocol (namespace `urn:x-cast:com.loteriaduo.game`, JSON)

Phone → TV
| type | fields |
|---|---|
| `hello` | `lang` ('es'\|'en'), `names` ('es'\|'en'\|'both'), `layout` ('card-board'\|'card'\|'board'), `caller` {name}, `deck` {id, name, type ('official'\|'custom'), cards: [{id, es, en, img}]} — `img` is `'classic'` (bundled art), an `https://` URL, or `null` (the phone will send it) |
| `state` | `sid` (game session id), `seq` (increasing), `status` ('ready'\|'playing'\|'paused'\|'ended'\|'winner'), `current` (card id or null), `called` (ids in order), `total`, `auto` {on, secs}, `winners` [names], `tie` (Tie Breaker round or null: {phase ('pick'\|'reveal'\|'done'), picks: [{id (card id, null while face down), who, top}], winner, next}); status is `'tie'` while it's open; optional `layout`, `names`, `lang` |
| `image` | `deckId`, `id`, `part`, `parts`, `mime`, `data` (base64 chunk, keep each message under 64 KB) |
| `ping` | heartbeat |

TV → phone
| type | fields |
|---|---|
| `ready` | `protocol`, `have` (card ids whose pictures it already has) |
| `need` | `deckId`, `ids` (pictures it can't load; current card first) |

Rules: the phone sends `hello` then a full `state` on every connect and resume. The TV ignores a `state`
whose `seq` is not newer for the same `sid`. If the phone disconnects, the TV keeps showing the last card
with a small "Reconnecting…" badge; the idle timeout is disabled.

## Deploy
Hosted with GitHub Pages at `https://loteriaduo.github.io/cast/` (the Receiver Application URL
registered in the Google Cast SDK Developer Console). Published from the public repo github.com/loteriaduo/cast (copy this folder into it and push).

## Assets and licenses
- Card art: Lotería Duo Classic deck (resized JPEGs in `img/classic/`). © Lotería Duo.
- Fonts: Open Sans and Lato, SIL Open Font License 1.1 (from Google Fonts).
- Google Cast Web Receiver SDK is loaded from Google's CDN at runtime.
