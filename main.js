/* Reading Vault — an Obsidian plugin for reading EPUB and PDF books inside
 * your vault, with highlights, notes and read-aloud. Licence: PolyForm
 * Shield 1.0.0 (see LICENSE in the public repository). Began as the native
 * replacement for an earlier personal reading tool ("A3's Reading Station").
 *
 * Storage: real vault notes with frontmatter, NOT a hidden database.
 * The folders below are the original A4 ones; since v0.18.0 they are a
 * setting (Settings -> Folders; see applyFolders()), and a new user starts
 * with "Reading", "Topics" and "Reading/Files".
 *   - Book notes:      04 Inner World/My Life/Reading/<Title>.md
 *   - Highlight notes: 04 Inner World/My Life/Reading/Highlights/<slug>.md
 *   - Topic notes:     04 Inner World/My Life/Topics/<Title>.md (existing
 *                       A4 convention — a linked highlight creates/reuses a
 *                       real Topic note and a real [[wikilink]], never a stub)
 *   - Binaries:         05 Assets/Reading/Books/ and .../Covers/ (05 Assets
 *                       is A4's existing "binary files only" room)
 *
 * Reading PROGRESS (last page/CFI, percent) lives in the book note's own
 * frontmatter too, same as every other field — but writes are debounced
 * (~1.5s after the reader goes idle, and flushed on screen change) rather
 * than fired on every single page turn, so normal reading doesn't spam the
 * vault with a frontmatter write per page. This is a deliberate design
 * choice carried over in spirit from A3 (which kept progress out of the
 * vault for the same churn reason) — not a hard technical blocker forcing a
 * database, just a debounce, so the requirement to avoid a hidden DB is
 * still honored: progress is real, readable frontmatter on the book note.
 *
 * EPUB reading/highlighting uses a hand-rolled ZIP + OPF parser (Node's
 * builtin zlib only, no dependency) ported from A3's epubCover.js, extended
 * here to also resolve the spine (chapter order) and decompress each
 * chapter's XHTML — matching A3's own "builtins only, no ZIP dependency"
 * convention. PDF reading draws each page with the PDF.js copy that ships
 * inside Obsidian itself (the public loadPdfJs() API, no added dependency):
 * a canvas plus PDF.js's selectable text layer, so text selection reaches
 * the same highlight flow as EPUB. (Until 2026-09-22 this was Chromium's
 * built-in viewer in an <iframe>, which keeps selection sealed inside its
 * own frame, so PDF highlighting could never fire.)
 *
 * No internet fetching anywhere in this file (per the build brief) — EPUB
 * covers come from the book's own embedded metadata only; PDFs get no
 * automatic cover (same v1 posture as A3) unless the user uploads one by
 * hand from the Detail sidebar.
 */
const {
  Plugin, ItemView, Modal, Notice, Setting, Menu, PluginSettingTab, loadPdfJs, setTooltip, TFile, requestUrl, Platform,
} = require('obsidian');
const crypto = require('crypto');
const zlib = require('zlib');

const VIEW_TYPE = 'a4-reading-view';
// Folders (v0.18.0, built to the approved docs/mockups/mockup-folders.html,
// John 2026-09-25): where Reading Vault keeps things is a setting now. Three
// folders are chosen; the rest sit inside them. A vault that already has
// books in the original A4 folders keeps using those (nothing moves); a
// new user starts with the short names. See ReadingPlugin.resolveFolders().
const LEGACY_FOLDERS = { reading: '04 Inner World/My Life/Reading', topics: '04 Inner World/My Life/Topics', files: '05 Assets/Reading' };
const NEW_USER_FOLDERS = { reading: 'Reading', topics: 'Topics', files: 'Reading/Files' };
let READING_DIR;
let HIGHLIGHTS_DIR;
let WORDS_DIR;
let TOPICS_DIR;
let FILES_DIR;
let BOOKS_ASSET_DIR;
let COVERS_ASSET_DIR;
let LANDING_NOTE;
function applyFolders({ reading, topics, files }) {
  READING_DIR = reading;
  HIGHLIGHTS_DIR = `${reading}/Highlights`;
  WORDS_DIR = `${reading}/Words`;
  LANDING_NOTE = `${reading}/Reading.md`;
  TOPICS_DIR = topics;
  FILES_DIR = files;
  BOOKS_ASSET_DIR = `${files}/Books`;
  COVERS_ASSET_DIR = `${files}/Covers`;
}
applyFolders(LEGACY_FOLDERS); // until the plugin's settings load

// A folder as typed in Settings, tidied: no leading/trailing slashes, no
// empty or "." / ".." parts. null when it can't be used.
function cleanFolderPath(raw) {
  const parts = String(raw || '').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((x) => x === '.' || x === '..' || /[:*?"<>|#^[\]]/.test(x) || x.startsWith('.'))) return null;
  return parts.join('/');
}

// listen_pos is written at most this often WHILE Listen keeps playing
// (page/chapter change, pause, stop, and closing the book still write
// immediately, via flushListenPosition -- see saveListenPosition()).
const LISTEN_POS_THROTTLE_MS = 30000;

// Same asset paths Obsidian's own PDF view passes to PDF.js (fonts/cmaps
// for PDFs that don't embed them). isEvalSupported:false also matches it.
const PDFJS_DOC_OPTIONS = {
  cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/lib/pdfjs/standard_fonts/',
  wasmUrl: '/lib/pdfjs/wasm/', iccUrl: '/lib/pdfjs/iccs/', isEvalSupported: false,
};

// Carried over EXACTLY from A3's readingHighlightColors.js — the same
// 5-value hex allowlist, same order.
const HIGHLIGHT_COLORS = [
  { hex: '#FFD54A', label: 'Yellow' },
  { hex: '#8FE3A6', label: 'Green' },
  { hex: '#8FC9F7', label: 'Blue' },
  { hex: '#F5A6C9', label: 'Pink' },
  { hex: '#C9A8F5', label: 'Lavender' },
];

// Highlights-in-the-book-note (v0.4.0 / v0.4.1). Colour is shown with a
// plugin-styled callout (`> [!a4-hl-<colour>]`, CSS in styles.css draws only
// a coloured left bar, no title/icon) rather than a word+emoji -- v0.4.0's
// "🟡 Yellow" read as a giant emoji glyph in John's theme font and the word
// was unwanted (John, 2026-09-23 live test). `HL_CALLOUT_TYPE` maps a known
// highlight hex to its callout type; an unrecognised hex (future palette
// change) falls back to a plain, uncallouted blockquote further down.
const HL_CALLOUT_TYPE = {
  Yellow: 'a4-hl-yellow', Green: 'a4-hl-green', Blue: 'a4-hl-blue', Pink: 'a4-hl-pink', Lavender: 'a4-hl-lavender',
};

// The auto-maintained section is bounded by the "## Highlights" heading
// itself running to the end of the note (the section is always kept last),
// NOT by a marker-comment pair. v0.4.0 used a `%% ... %%` comment pair, but
// Obsidian's Live Preview renders ANY %% %% comment (and code-comment
// syntax) through the same shared `.cm-comment` style -- there is no
// per-plugin or per-marker CSS hook to hide only ours without hiding every
// other comment in the vault (a vault-wide side effect, out of scope and
// against the brief's own "text outside must never be touched" guarantee
// in spirit). Anchoring on the heading instead means there is no marker
// text left to render at all, in Reading view OR Live Preview, and the
// guarantee is even simpler to state: everything before the "## Highlights"
// line is never read from, computed from, or written to -- only the exact
// byte offset of that heading is located, and only content from that offset
// to end-of-file is ever replaced.
const HL_SECTION_HEADING = '## Highlights';

const STATUS_LABELS = { 'to-read': 'To Read', reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };
const VALID_STATUSES = ['to-read', 'reading', 'finished', 'abandoned'];

// Reading-session recording (2026-09-23 proof of concept, groundwork for a
// future paid Reading dashboard -- not built here). See the SessionRecorder
// class below for the on-disk format.
const SESSION_TICK_MS = 20000; // how often tick() re-checks the running session
const SESSION_IDLE_MS = 2 * 60 * 1000; // no page turn/scroll while reading -> session ends
const SESSION_CRASH_GUARD_MS = 3 * 60 * 1000; // save an in-progress session at most this often
const SESSION_NOISE_MIN_MINUTES = 0.1; // 6s -- a session shorter than this with 0 pages is discarded
const SESSION_FILE_NAME = 'sessions.json';
// MIN_PAGE_TURN_MS (2026-09-23 fix) -- a page turned faster than this since
// the last one COUNTED is skimming or a stuck/failed turn (the reader UI
// not actually moving, e.g. the "P.41 of 42" freeze fixed the same day)
// mashed repeatedly, not a page actually read. notePageTurn() still keeps
// the session alive on every click (real activity), it just excludes turns
// this fast from the `pages` count that computeReadingPace() divides real
// minutes by -- otherwise a burst of clicks against a stuck page (or fast
// flipping) drags the pace down and "time left in book" collapses, exactly
// what John saw (9h21m -> 5h56m while paging, no real reading in between).
const MIN_PAGE_TURN_MS = 5000;
// SESSION_MIN_PLAUSIBLE_MIN_PER_PAGE -- a session whose own average pace
// implies faster than this (~6s/page, well under any real reading speed)
// is flip-through noise start-to-finish, not reading; flagged out of the
// pace pool entirely at endCurrent() rather than diluting
// computeReadingPace()'s real average. A single fast burst that doesn't
// drag the WHOLE session's average this low is still caught per-turn by
// notePageTurn()'s MIN_PAGE_TURN_MS gate instead.
const SESSION_MIN_PLAUSIBLE_MIN_PER_PAGE = 0.1;

// Listen (read-aloud) feature — Web Speech API settings/constants.
const TTS_SPEEDS = [0.8, 1.0, 1.2, 1.5, 2.0];
// ttsLanguage: 'en' reads with Kokoro; any other language code (e.g. 'es')
// reads with the Mac's own voices for that language. ttsVoices[lang] =
// { ticked: [voice ids], default: voice id } -- each language keeps its own
// (Kokoro ids look like "kokoro:af_heart", system ones are voiceURIs).
// pageColour: the Reader's starting page colour -- 'auto' follows the
// computer's light/dark setting live; 'dark'/'light' are fixed.
// highlightsInBookNote: default ON per brief -- keeps every book's own note
// carrying a live, plain-text "Highlights" section. highlightsBackfillDone
// guards the one-time, gentle pass that builds that section for books that
// already had highlights before this feature shipped; it is never re-run
// automatically once true (see runHighlightsBackfillIfNeeded()).
// textFont/textSize/lineSpacing/textMargins/justifyText: the "Aa" popover's
// text-look settings (v0.6.0) -- global across every book, same posture as
// pageColour, never written to a book note's own frontmatter. textSize
// replaces the old per-session-only `this.reader.fontSize` (reset to 16
// every time a book was opened, never actually persisted anywhere before
// this pass -- see the Text settings build notes). textMargins is
// [vertical, horizontal] padding in px, matching the live CSS's own
// shorthand order. Defaults match the CURRENT live look exactly (no visual
// change until a reader actually opens the popover): serif/16px/1.85/
// [34,44]/not justified.
// listenBarHidden (v0.7.0): global, not per-book -- same posture as
// pageColour/textSize. Toggled by the Listen bar's own ✕ or the toolbar's
// 🎧 button (see hideListenBar()/showListenBar()); while hidden, the
// reading-progress strip (buildProgressStrip()) takes the Listen bar's
// slot instead. Per the approved mockup (mockup-reading-mode.html).
const DEFAULT_SETTINGS = {
  ttsSpeed: 1.0, ttsLanguage: 'en', ttsVoices: {}, pageColour: 'auto', highlightsInBookNote: true, highlightsBackfillDone: false,
  textFont: 'serif', textSize: 16, lineSpacing: 1.85, textMargins: [34, 44], justifyText: false,
  listenBarHidden: false,
  // Reading Dashboard goals (v0.8.0) -- plugin settings only, never a
  // vault note. Defaults are the targets shown on the approved mockup;
  // John edits them from the dashboard's steppers / "Edit goals".
  // reminderLastShown is the local day key ("YYYY-MM-DD") the evening
  // reminder last fired, so it fires at most once a day.
  goalDailyMinutes: 30, goalWeeklyMinutes: 150, goalYearlyBooks: 12,
  listeningCountsTowardGoals: true, reminderEnabled: false, reminderTime: '20:00', reminderLastShown: null,
  // Highlight review (v0.9.0). reviewDay is { date: "YYYY-MM-DD", done: n },
  // how many were reviewed on that local day, so the daily set never grows
  // past reviewPerDay. The schedule itself lives on each highlight note.
  reviewPerDay: 5, reviewRememberFirst: false, reviewDay: null,
  // Ask the book (v0.10.0). Off until turned on. Keys are NEVER stored
  // here -- they live in Obsidian's secure storage (see askKey()).
  askEnabled: false, askProvider: 'anthropic', askModels: {},
  askSendHighlights: true, askSendTopics: true, askSendChapter: true,
  // Shelves (v0.12.0): [{ name, order: [book paths] }]. Always replaced, never
  // mutated in place (this default array is shared -- see ttsVoices below).
  shelves: [],
  // Word lookup (v0.13.0): the Pro "Explain in this sentence" switch. The
  // dictionaries themselves live outside the vault (see dictionaryDir()).
  lookupAiEnabled: false,
};

// Reading progress strip pace (v0.7.0) -- "minutes per page" is the one
// pace unit used for both the chapter- and book-level estimate, chosen
// because it's exactly what the v0.6.1 SessionRecorder already stores per
// session (activeMinutes, pages) -- no extra word-counting pass needed to
// use real data. Real pace: average minutes/page from this book's own
// 'read'-mode sessions, once there are enough real turned pages to trust
// (READ_PACE_MIN_PAGES). Fallback (first time on a book, or not enough
// data yet): the Decision resolved 2026-09-23 as ~250 words/min, converted
// here to minutes/page via a commonly-cited average print-page word count
// (WORDS_PER_PAGE_ASSUMED) -- a documented estimate, not a measurement,
// since there's no real reading to measure yet. See computeReadingPace().
const READ_PACE_MIN_PAGES = 3;
const FALLBACK_WPM = 250;
const WORDS_PER_PAGE_ASSUMED = 275;
const FALLBACK_MIN_PER_PAGE = WORDS_PER_PAGE_ASSUMED / FALLBACK_WPM;

// Kokoro-82M offline neural voice (Apache-2.0), offered next to the system
// voices in the Voice list. Test setup for John's own copy: kokoro-js (and
// the ONNX runtime it brings) is npm-installed in KOKORO_HOME and loaded
// with Node's require; the model downloads once into KOKORO_HOME/models.
// Both live OUTSIDE the vault on purpose: the vault auto-commits to GitHub
// and syncs to the phone, and the model alone is ~90 MB. A public release
// would bundle the library instead (no loading code from outside the
// plugin) and still keep the model download out of the vault.
const KOKORO_HOME = require('path').join(require('os').homedir(), 'Library', 'Application Support', 'a4-reading-kokoro');
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_CANCELLED = 'A4R_KOKORO_CANCELLED';
const KOKORO_GEN_TIMEOUT = 'A4R_KOKORO_GEN_TIMEOUT';
// A single Kokoro (local ONNX, CPU) synthesis call has no engine-side
// timeout of its own -- an abnormally long piece of text (or a genuinely
// stuck inference on a given Mac) can hang indefinitely with no error and
// no event, which reads to the user as "the voice just stopped" with no
// recovery until they notice and press Play again. Racing every generation
// call against this ceiling turns a silent hang into the same recoverable
// failure an outright Kokoro error already gets: retried with the SAME
// chosen Kokoro voice (see KOKORO_MAX_RETRIES below), never switched to the
// system voice -- John decided 2026-09-23 to stick with the chosen voice,
// full stop. Root-caused 2026-09-23 against a real case: a
// sentence-splitting bug (see isFootnoteMarkerAnchor) had merged three
// sentences' worth of text into one ~80-word utterance, which is the kind
// of input this ceiling exists to protect against even after that specific
// merge is fixed at the source.
// A very long "sentence" (a poem, a list, a contents page read as one)
// gets proportionally longer, so it isn't mistaken for a stall.
const KOKORO_GEN_TIMEOUT_MS = 20000;
const KOKORO_GEN_MS_PER_CHAR = 50;
function kokoroTimeoutFor(text) {
  return Math.max(KOKORO_GEN_TIMEOUT_MS, String(text || '').length * KOKORO_GEN_MS_PER_CHAR);
}
function withKokoroTimeout(promise, ms = KOKORO_GEN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(KOKORO_GEN_TIMEOUT)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
// A stall or an outright Kokoro failure on the current sentence is retried
// with the same chosen voice this many times (so up to 3 tries total)
// before Listen gives up on it. Never falls back to the system voice --
// John's decision 2026-09-23. KOKORO_RETRY_BACKOFF_MS is the pause before
// each retry, short enough not to feel like a second stall on top of the
// first.
const KOKORO_MAX_RETRIES = 2;
const KOKORO_RETRY_BACKOFF_MS = 600;
const KOKORO_DTYPE = 'q8'; // 88 MB; fp32 is 320 MB -- quality is reported close, q8 chosen for size
const KOKORO_MODEL_DIR = require('path').join(KOKORO_HOME, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
// Kokoro's better-graded English voices (grades from kokoro-js's own list):
// ticked by default.
const KOKORO_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'bf_emma', 'af_aoede', 'af_kore', 'af_sarah', 'am_fenrir', 'am_michael', 'am_puck', 'bm_george', 'bm_fable'];
// All 28 English voices kokoro-js ships, in its own quality order:
// [id, name, accent, woman/man, best-graded].
const KOKORO_ALL_VOICES = [
  ['af_heart', 'Heart', 'US', 'w', true], ['af_bella', 'Bella', 'US', 'w', true], ['af_nicole', 'Nicole', 'US', 'w'], ['af_aoede', 'Aoede', 'US', 'w'],
  ['af_kore', 'Kore', 'US', 'w'], ['af_sarah', 'Sarah', 'US', 'w'], ['af_nova', 'Nova', 'US', 'w'], ['af_sky', 'Sky', 'US', 'w'], ['af_alloy', 'Alloy', 'US', 'w'],
  ['af_jessica', 'Jessica', 'US', 'w'], ['af_river', 'River', 'US', 'w'], ['bf_emma', 'Emma', 'UK', 'w'], ['bf_isabella', 'Isabella', 'UK', 'w'],
  ['bf_alice', 'Alice', 'UK', 'w'], ['bf_lily', 'Lily', 'UK', 'w'],
  ['am_fenrir', 'Fenrir', 'US', 'm'], ['am_michael', 'Michael', 'US', 'm'], ['am_puck', 'Puck', 'US', 'm'], ['am_echo', 'Echo', 'US', 'm'], ['am_eric', 'Eric', 'US', 'm'],
  ['am_liam', 'Liam', 'US', 'm'], ['am_onyx', 'Onyx', 'US', 'm'], ['am_adam', 'Adam', 'US', 'm'], ['am_santa', 'Santa', 'US', 'm'],
  ['bm_george', 'George', 'UK', 'm'], ['bm_fable', 'Fable', 'UK', 'm'], ['bm_lewis', 'Lewis', 'UK', 'm'], ['bm_daniel', 'Daniel', 'UK', 'm'],
];
// Short preview lines for the settings page's ▶ buttons, in the voice's
// own language where we have one.
const PREVIEW_LINES = {
  en: 'Hello. This is how I sound reading your books aloud.',
  es: 'Hola. Así sueno cuando leo tus libros en voz alta.',
  fr: 'Bonjour. Voici ma voix quand je lis vos livres à voix haute.',
  de: 'Hallo. So klinge ich, wenn ich deine Bücher vorlese.',
  it: 'Ciao. Ecco come suono quando leggo i tuoi libri ad alta voce.',
  pt: 'Olá. É assim que eu soo lendo os seus livros em voz alta.',
  nl: 'Hallo. Zo klink ik als ik je boeken voorlees.',
  sv: 'Hej. Så här låter jag när jag läser dina böcker högt.',
  da: 'Hej. Sådan lyder jeg, når jeg læser dine bøger højt.',
  nb: 'Hei. Slik høres jeg ut når jeg leser bøkene dine høyt.',
  fi: 'Hei. Tältä kuulostan, kun luen kirjojasi ääneen.',
  pl: 'Cześć. Tak brzmię, czytając twoje książki na głos.',
  ru: 'Здравствуйте. Так я звучу, когда читаю ваши книги вслух.',
  ja: 'こんにちは。本を読み上げるときの私の声です。',
  zh: '你好。这是我朗读你的书时的声音。',
  ko: '안녕하세요. 책을 소리 내어 읽을 때 제 목소리입니다.',
};

// Reader page Light/Dark colors, forced via inline style rather than left to
// CSS custom properties. The book page's own Dark/Light toggle is meant to
// be independent of Obsidian's own light/dark theme, but --a4r-page/
// --a4r-ink were only ever defined two ways: the plain :root default (a
// light page) and a `.theme-dark .a4r-root` override (a dark page) keyed to
// OBSIDIAN's theme -- with no path that responds to the reader's own toggle
// at all. The hardcoded `.a4r-reader-page.a4r-dark` CSS rule happens to use
// the exact same RGB values as that Obsidian-dark override, so with
// Obsidian itself in dark mode, selecting "Light" in the reader produced
// identical colors to "Dark" (dark page, same as the surrounding app) --
// selecting "Light" never actually got you a light page. Setting these
// directly by the reader's OWN theme state, every time, makes the toggle
// authoritative in both of Obsidian's themes.
const A4R_READER_COLORS = {
  light: { page: '#f7f2e6', ink: '#2b2622' },
  dark: { page: '#221f18', ink: '#ece5d5' },
};

// Text settings ("Aa" popover, v0.6.0) -- per the approved mockup
// (mockup-text-settings.html). 'serif' is the current live default (kept
// as-is so nobody's book changes on its own the first time they open this).
// 'easy' is Atkinson Hyperlegible (Braille Institute, SIL OFL 1.1) --
// bundled the same self-hosted-base64-@font-face way A4R Fraunces/Work Sans
// already are (see styles.css), real font files + the real OFL.txt also
// kept under this plugin's own fonts/ folder for provenance/licence
// auditability. 'theme' reads Obsidian's own `--font-text` (confirmed the
// real variable name by extracting the live app.css from obsidian.asar,
// not assumed) so it tracks whatever John's active Obsidian theme sets for
// its own body text, not a hardcoded name.
const TEXT_FONT_STACKS = {
  serif: "'A4R Fraunces', Georgia, serif",
  sans: "'A4R Work Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  easy: "'A4R Atkinson Hyperlegible', Verdana, Tahoma, sans-serif",
  theme: 'var(--font-text)',
};
const TEXT_FONT_LABELS = {
  serif: "Serif (the book's own look)", sans: 'Sans-serif', easy: 'Easy-read', theme: 'Match my Obsidian theme',
};
// "Relaxed"/"Normal" are marked as the live default in the popover because
// they map to the CURRENT fixed CSS values (line-height:1.85, padding:34px
// 44px) -- an existing reader sees no change until they touch a control.
const LINE_SPACING_STEPS = [
  { key: 'tight', val: 1.5, label: 'Tight' },
  { key: 'normal', val: 1.7, label: 'Normal' },
  { key: 'relaxed', val: 1.85, label: 'Relaxed' },
  { key: 'loose', val: 2.05, label: 'Loose' },
];
const MARGIN_STEPS = [
  { key: 'narrow', val: [20, 28], label: 'Narrow' },
  { key: 'normal', val: [34, 44], label: 'Normal' },
  { key: 'wide', val: [48, 64], label: 'Wide' },
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

// v0.14.1 (John's screenshot 2026-09-24): a chapter's opening heading
// brought its own top space on top of the page margin, so the first line
// sat well down the page. Clears the top margin of the first element with
// real content and every wrapper above it (and of any empty elements
// before it). Inline styles are copied along if Listen later splits the
// heading into a sentence, so the fix survives that too.
function trimChapterTopGap(root) {
  let el = root.firstElementChild;
  for (let guard = 0; el && guard < 16; guard++) {
    const empty = !el.textContent.trim() && !el.querySelector('img,svg,image,video');
    el.style.marginTop = '0';
    if (empty) { el = el.nextElementSibling; continue; }
    const lead = el.firstChild;
    if (lead && lead.nodeType === 3 && lead.nodeValue.trim()) break;
    el = el.firstElementChild;
  }
}

// Full screen (v0.15.0): how close to the top the mouse brings the slim
// bar back, and how long the "Esc to exit" hint shows.
const FULL_SCREEN_TOP_ZONE = 56;
const FULL_SCREEN_HINT_MS = 2600;

// The four-corners icon on the toolbar's full screen button.
function fullScreenIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  svg.appendChild(path);
  return svg;
}

// QA fix (v0.17.2): a book's chapter HTML goes into Obsidian's own window,
// which can reach this computer's files, so only reading content is kept.
// Removes anything that runs code, loads another page or talks to the
// internet: scripts, frames, embedded objects, forms, media, redirects,
// event handlers and javascript:/data: links. Text, headings, lists,
// tables, images and links inside the book stay.
// v0.17.3 adds SVG animation elements (they can rewrite a link or
// picture address after cleaning) and SVG filter images.
const CHAPTER_DROP = 'script,style,link,iframe,frame,frameset,object,embed,applet,meta,base,form,input,button,textarea,select,audio,video,source,track,portal,template,animate,set,animateMotion,animateTransform,animateColor,discard,feImage,foreignObject';
function sanitizeChapterDoc(doc) {
  doc.querySelectorAll(CHAPTER_DROP).forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || '').replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'srcset'
        || name === 'background' || name === 'poster' || name === 'ping') {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'xlink:href' || name === 'src' || name === 'action')
        && /^(javascript|vbscript|data):/.test(value) && !/^data:image\//.test(value)) {
        el.removeAttribute(attr.name);
      } else if (name === 'style' && /url|image-set|expression|@import|\\|:\/\//i.test(attr.value)) {
        // Any style that could name another file or address, including
        // escaped or image-set() forms, is dropped whole (QA fix v0.17.3).
        el.removeAttribute(attr.name);
      }
    }
  });
  // SVG <use> pointing outside the page could load another file.
  doc.querySelectorAll('use').forEach((u) => {
    const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
    if (h && !h.startsWith('#')) u.remove();
  });
}

// After the book's own images are turned into blob: links, drop any image
// still pointing elsewhere (e.g. an https:// tracker in the book).
function dropRemoteImages(doc) {
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !/^(blob:|data:image\/)/i.test(src)) img.removeAttribute('src');
  });
  doc.querySelectorAll('image').forEach((im) => {
    const h = im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || im.getAttribute('href') || '';
    if (h && !/^(blob:|data:image\/)/i.test(h)) im.remove();
  });
}

// A frontmatter value shown as text: a list becomes "a, b", anything else
// its plain text, missing becomes ''.
function fmText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => fmText(x)).filter(Boolean).join(', ');
  return String(v);
}

// Tags as a list, whatever way they were typed in the note (QA fix
// v0.17.2): "tags: philosophy" or "tags: zen, buddhism" used to show as no
// tags, and adding one replaced them. A leading # is dropped, as Obsidian
// does.
function normTagList(tags) {
  const list = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(/[,\s]+/) : []);
  const out = [];
  for (const x of list) {
    const tag = String(x == null ? '' : x).trim().replace(/^#/, '');
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// Where a saved page sits in its chapter, 0 (first page) to 1 (last), so
// it lands on the same page when the chapter has a different number of
// pages. QA fix (v0.17.3): this used page/total, which is applied against
// total-1, so any page in the second half of a chapter came back one page
// early.
function pageFraction(page, total) {
  if (!(total > 1)) return 0;
  return Math.max(0, Math.min(1, page / (total - 1)));
}

// Room kept free under the Text settings panel for Obsidian's status bar.
const TEXTSET_BOTTOM_ROOM = 36;

// Puts a position:fixed element at (top, left) in window coordinates. Inside
// Obsidian a pane can become the frame fixed elements are measured from
// (it has its own containment), which shifts them by the pane's offset;
// this measures where the element really landed and corrects for it.
function placeFixedPopup(el, top, left) {
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  const got = el.getBoundingClientRect();
  const dx = got.left - left;
  const dy = got.top - top;
  if (Math.abs(dx) > 0.5) el.style.left = `${left - dx}px`;
  if (Math.abs(dy) > 0.5) el.style.top = `${top - dy}px`;
}
// QA fix v0.17.3: no leading "." (that makes a hidden note), and the
// length is limited in bytes, not letters -- the Mac allows 255 bytes, and
// a non-English letter takes 2 to 4, so 150 letters could be too long.
function sanitizeFilename(s) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  let out = '';
  let bytes = 0;
  for (const ch of cleaned || 'Untitled') {
    if (out.length >= 150) break;
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > 180) break;
    out += ch;
    bytes += b;
  }
  return out.trim() || 'Untitled';
}

function slugifyTitle(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'topic';
}

async function uniqueVaultPath(app, dir, baseName, ext) {
  let candidate = `${dir}/${baseName}.${ext}`;
  let n = 1;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = `${dir}/${baseName} (${n}).${ext}`;
    n += 1;
  }
  return candidate;
}

async function ensureFolder(app, path) {
  if (!app.vault.getAbstractFileByPath(path)) {
    try { await app.vault.createFolder(path); } catch { /* race, fine */ }
  }
}

function fmtPercent(p) {
  return typeof p === 'number' && Number.isFinite(p) ? `${Math.max(0, Math.min(100, Math.round(p)))}%` : '0%';
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n).trim()}…` : str;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sniffBookFormat(buf) {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf'; // %PDF
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'epub'; // PK.. zip
  return null;
}

function sniffImageExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function pickPlaceholderColor(title) {
  const palette = [
    ['#efe9dd', '#2b2622'], ['#2c2a26', '#8fe0c8'], ['#d8ac4a', '#2b2216'],
    ['#f0e0c4', '#8a5a2b'], ['#e2ebf5', '#5e86b8'], ['#f5a6c9', '#5c2436'],
  ];
  let h = 0;
  for (let i = 0; i < title.length; i += 1) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// ---------------------------------------------------------------------------
// Hand-rolled ZIP / EPUB parsing (builtins only — ported and extended from
// A3's server/epubCover.js: central-directory ZIP reader + tolerant OPF
// regex reads, plus spine resolution which A3's version didn't need).
// ---------------------------------------------------------------------------
const MAX_ENTRY_BYTES = 30 * 1024 * 1024;
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return { cdOffset: buf.readUInt32LE(i + 16), cdSize: buf.readUInt32LE(i + 12) };
    }
  }
  return null;
}

function parseCentralDirectory(buf, eocd) {
  const entries = new Map();
  let off = eocd.cdOffset;
  const end = Math.min(buf.length, eocd.cdOffset + eocd.cdSize);
  while (off + 46 <= end) {
    if (buf.readUInt32LE(off) !== CD_SIG) break;
    const compressionMethod = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const filenameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const nameStart = off + 46;
    const nameEnd = nameStart + filenameLen;
    if (nameEnd > buf.length) break;
    const filename = buf.toString('utf8', nameStart, nameEnd);
    entries.set(filename, { filename, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    off = nameEnd + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length) return null;
  if (buf.readUInt32LE(lh) !== LOCAL_SIG) return null;
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) return null;
  const localFilenameLen = buf.readUInt16LE(lh + 26);
  const localExtraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + localFilenameLen + localExtraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length || dataEnd < dataStart) return null;
  const raw = buf.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return raw.length === entry.uncompressedSize ? Buffer.from(raw) : null;
  if (entry.compressionMethod === 8) {
    try {
      const out = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      return out.length > MAX_ENTRY_BYTES ? null : out;
    } catch { return null; }
  }
  return null;
}

// An EPUB's inner links are web addresses, so a file named "My Chapter.xhtml"
// is written "My%20Chapter.xhtml" (QA fix v0.17.3: those chapters and
// pictures used to be not found).
function posixJoinNormalize(dir, href) {
  if (typeof href !== 'string' || !href || href.includes('\0')) return null;
  if (href.includes('%')) {
    try { href = decodeURIComponent(href); } catch { /* keep as written */ }
    if (href.includes('\0')) return null;
  }
  const parts = (dir === '.' ? [] : dir.split('/')).concat(href.split('/'));
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function locateOpf(zipBuf) {
  const eocd = findEocd(zipBuf);
  if (!eocd) return null;
  const entries = parseCentralDirectory(zipBuf, eocd);
  const containerEntry = entries.get('META-INF/container.xml');
  if (!containerEntry) return null;
  const containerXml = readZipEntry(zipBuf, containerEntry)?.toString('utf8');
  if (!containerXml) return null;
  const rootfile = /<(?:[\w-]+:)?rootfile\b([^>]*)>/i.exec(containerXml);
  const opfPath = rootfile ? xmlAttr(rootfile[1], 'full-path') : null;
  if (!opfPath) return null;
  const opfEntry = entries.get(opfPath);
  if (!opfEntry) return null;
  const opfXml = readZipEntry(zipBuf, opfEntry)?.toString('utf8');
  if (!opfXml) return null;
  return {
    opfXml, opfPath, entries, opfDir: opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '.',
  };
}

// One attribute's value from a tag's attribute text, in "double" or
// 'single' quotes (QA fix v0.17.3: single quotes used to be missed).
function xmlAttr(attrs, name) {
  const m = new RegExp(`(?:^|[^\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs || '');
  if (!m) return undefined;
  return decodeXmlEntities(m[1] !== undefined ? m[1] : m[2]);
}

// Also numbered characters like &#233; and &#xE9; (QA fix v0.17.3: EPUB
// titles showed "Caf&#233;").
function decodeXmlEntities(s) {
  const code = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '');
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d{1,7});/g, (m, n) => code(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => code(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractFirstElement(opfXml, tagName) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagName}>`, 'i');
  const m = re.exec(opfXml);
  if (!m) return null;
  const raw = decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim();
  return raw || null;
}

function extractCoverHref(opfXml) {
  const itemRe = /<item\b([^>]*)\/?>/gi;
  const items = [];
  let m;
  while ((m = itemRe.exec(opfXml)) !== null) {
    const attrs = m[1];
    const id = xmlAttr(attrs, 'id');
    const href = xmlAttr(attrs, 'href');
    const properties = xmlAttr(attrs, 'properties') || '';
    items.push({ id, href, properties });
  }
  const epub3Cover = items.find((it) => it.href && it.properties.split(/\s+/).includes('cover-image'));
  if (epub3Cover) return epub3Cover.href;
  const metaRe = /<meta\b([^>]*)>/gi;
  let coverId = null;
  while (coverId === null && (m = metaRe.exec(opfXml)) !== null) {
    if (xmlAttr(m[1], 'name') === 'cover' && xmlAttr(m[1], 'content')) coverId = xmlAttr(m[1], 'content');
  }
  if (coverId !== null) {
    const byId = items.find((it) => it.id === coverId && it.href);
    if (byId) return byId.href;
  }
  return null;
}

function parseManifestAndSpine(opfXml) {
  const manifest = new Map(); // id -> href
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let m;
  while ((m = itemRe.exec(opfXml)) !== null) {
    const attrs = m[1];
    const id = xmlAttr(attrs, 'id');
    const href = xmlAttr(attrs, 'href');
    if (id && href) manifest.set(id, href);
  }
  const spineIds = [];
  const spineMatch = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opfXml);
  if (spineMatch) {
    const itemrefRe = /<itemref\b([^>]*)\/?>/gi;
    let mm;
    while ((mm = itemrefRe.exec(spineMatch[1])) !== null) {
      const idref = xmlAttr(mm[1], 'idref');
      if (idref) spineIds.push(idref);
    }
  }
  return { manifest, spineIds };
}

// extractEpubCover — same contract as A3's version: {buf, ext} or null.
function extractEpubCover(zipBuf) {
  try {
    const located = locateOpf(zipBuf);
    if (!located) return null;
    const coverHref = extractCoverHref(located.opfXml);
    if (!coverHref) return null;
    const resolved = posixJoinNormalize(located.opfDir, coverHref);
    if (!resolved) return null;
    const entry = located.entries.get(resolved);
    if (!entry) return null;
    const buf = readZipEntry(zipBuf, entry);
    if (!buf || !buf.length) return null;
    const ext = sniffImageExt(buf);
    if (!ext) return null;
    return { buf, ext };
  } catch { return null; }
}

function extractEpubTitle(zipBuf) {
  try { const l = locateOpf(zipBuf); return l ? extractFirstElement(l.opfXml, 'title') : null; } catch { return null; }
}
function extractEpubAuthor(zipBuf) {
  try { const l = locateOpf(zipBuf); return l ? extractFirstElement(l.opfXml, 'creator') : null; } catch { return null; }
}

// ---------------- Book summary (v0.14.0) ----------------
// Built to the approved docs/mockups/mockup-book-summary.html. A book's own
// description (the back-cover blurb publishers put in the file) is copied
// into the book's note under "## Summary" when the book is added (John,
// 2026-09-24). Pro can also have AI write one.

// Publisher descriptions are often HTML, sometimes escaped twice. Returns
// plain paragraphs separated by a blank line, or null when there's nothing
// worth showing.
function cleanBookDescription(raw) {
  if (!raw) return null;
  let s = String(raw);
  for (let i = 0; i < 2 && /&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/i.test(s); i++) {
    s = decodeXmlEntities(s).replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&nbsp;/g, ' ');
  }
  s = s.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n\n').replace(/<[^>]+>/g, '');
  const paras = s.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = paras.join('\n\n');
  return text.length >= 40 ? text.slice(0, SUMMARY_MAX_CHARS).trim() : null;
}
const SUMMARY_MAX_CHARS = 4000;

// The raw <dc:description>, keeping its line breaks and markup for
// cleanBookDescription (extractFirstElement flattens whitespace).
function extractEpubDescription(zipBuf) {
  try {
    const l = locateOpf(zipBuf);
    if (!l) return null;
    const m = /<(?:[\w-]+:)?description\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?description>/i.exec(l.opfXml);
    return m ? cleanBookDescription(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : null;
  } catch { return null; }
}

// EPUB: its description. PDF: the "Subject" field, only when it reads like
// a real description (a dozen words or more), since most PDFs put a short
// label or nothing there.
function extractBookDescription(buf, format) {
  if (format === 'epub') return extractEpubDescription(buf);
  if (format === 'pdf') {
    const subj = extractPdfInfoField(buf, 'Subject');
    return subj && subj.trim().split(/\s+/).length >= 12 ? cleanBookDescription(subj) : null;
  }
  return null;
}

// Quick summary (John's choice "a"): the description, the chapter titles
// and what the model already knows. The book's text is never sent. No
// spoilers; about as long as the cover is tall.
const SUMMARY_SYSTEM_PROMPT = [
  'You write a short summary of a book for the reader\'s own library, shown next to its cover.',
  'Use what you are given (the title, the author, the publisher\'s description if any, and the chapter titles if any) plus what you already know about the book.',
  'Do not give away the ending, twists or how things turn out. Describe the premise, what the book covers, and its tone.',
  'If you do not recognise the book and the details given are thin, say briefly what it appears to be about from those details, and do not invent specifics.',
  'Write about 110 to 150 words in two or three short paragraphs of plain, warm prose, in the same language as the book\'s title and description. No headings, no bullet lists, no preamble like "Here is a summary".',
].join('\n');
const SUMMARY_CHAPTERS_MAX = 60;

function buildSummaryMessage({ title, author, description, chapters }) {
  const lines = [`Book: ${title}${author ? ` by ${author}` : ''}`];
  if (description) lines.push('', 'Publisher\'s description:', String(description).trim());
  const ch = (chapters || []).map((c) => String(c).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, SUMMARY_CHAPTERS_MAX);
  if (ch.length) lines.push('', 'Chapter titles:', ...ch.map((c) => `- ${c}`));
  lines.push('', 'Write the summary.');
  return lines.join('\n');
}

// The sections Reading Vault itself writes in a book note, in order. QA fix
// (v0.17.2): a section used to end at ANY "## " line, so a heading inside
// the reader's own notes (or an AI answer) cut the section short and the
// rest was left behind or overwritten. Now a section ends only at the next
// one of these, or the end of the note. Highlights is generated and ends
// at any "## " heading, so a section the reader adds after it survives.
const BOOK_NOTE_SECTIONS = ['Summary', 'Notes', 'Questions', 'Highlights'];

// { start, bodyStart, end } of "## <name>" in a book note, or null.
function findNoteSection(content, name) {
  let m = null;
  if (name === 'Highlights') {
    // The generated Highlights section is always the last one Reading Vault
    // writes, so take the LAST such heading (QA fix v0.17.3): one typed in
    // Obsidian inside the reader's own notes is never mistaken for it.
    const all = [...content.matchAll(/^## Highlights[ \t]*$/gm)];
    m = all.length ? all[all.length - 1] : null;
  } else {
    m = new RegExp(`^## ${name}[ \\t]*$`, 'm').exec(content);
  }
  if (!m) return null;
  const bodyStart = m.index + m[0].length;
  const rest = content.slice(bodyStart);
  // Highlights ends at any heading of any level, so a reader's own "# ..."
  // or "### ..." section after it is kept too (QA fix v0.17.3).
  const enders = name === 'Highlights'
    ? /^#{1,6} \S/m
    : new RegExp(`^## (?:${BOOK_NOTE_SECTIONS.filter((x) => x !== name).join('|')})[ \\t]*$`, 'm');
  const next = enders.exec(rest);
  return { start: m.index, bodyStart, end: next ? bodyStart + next.index : content.length };
}

// Text the reader writes into one section (Notes, a summary) can't create
// another section by accident (QA fix v0.17.3): a line such as
// "## Highlights" typed in the Notes box became the plugin's own section
// heading, and the next highlight replaced what was under it. Such lines
// become "### ..." -- still a heading, but never one of Reading Vault's own.
function guardReservedHeadings(text) {
  return String(text || '').replace(new RegExp(`^#{1,2} (${BOOK_NOTE_SECTIONS.join('|')})[ \\t]*$`, 'gmi'), '### $1');
}

// A section's text, or '' when there isn't one.
function readNoteSection(content, name) {
  const sec = findNoteSection(content, name);
  if (!sec) return '';
  return content.slice(sec.bodyStart, sec.end).replace(/^\n+/, '').trimEnd();
}

// Sets (or, with empty text, removes) the "## Summary" section. It sits
// right after the frontmatter and title, above "## Notes" and every other
// section; everything else stays byte-for-byte.
function writeSummarySection(content, text) {
  // A summary's own headings sit under Summary (QA fix v0.17.3), like an
  // AI answer's do under its question.
  const clean = String(text || '').trim().replace(/^#{1,3} /gm, '#### ');
  const block = clean ? `## Summary\n\n${clean}\n` : '';
  const sec = findNoteSection(content, 'Summary');
  if (sec) {
    const head = content.slice(0, sec.start).trimEnd();
    const tail = content.slice(sec.end);
    if (block) return `${head ? `${head}\n\n` : ''}${block}${tail ? `\n${tail}` : ''}`;
    return tail ? `${head ? `${head}\n\n` : ''}${tail}` : `${head}\n`;
  }
  if (!block) return content;
  const firstSection = /^## \S/m.exec(content);
  if (firstSection) {
    const head = content.slice(0, firstSection.index).trimEnd();
    return `${head ? `${head}\n\n` : ''}${block}\n${content.slice(firstSection.index)}`;
  }
  return `${content.trimEnd()}\n\n${block}`;
}

// getEpubSpine — resolves the full reading order as an array of
// { href, resolvedPath } in spine order. Returns null on any failure.
function getEpubSpine(zipBuf) {
  try {
    const located = locateOpf(zipBuf);
    if (!located) return null;
    const { manifest, spineIds } = parseManifestAndSpine(located.opfXml);
    const spine = [];
    for (const id of spineIds) {
      const href = manifest.get(id);
      if (!href) continue;
      const resolved = posixJoinNormalize(located.opfDir, href);
      if (resolved) spine.push({ href, resolvedPath: resolved });
    }
    return { spine, entries: located.entries, opfDir: located.opfDir };
  } catch { return null; }
}

function readSpineChapter(zipBuf, entries, resolvedPath) {
  const entry = entries.get(resolvedPath);
  if (!entry) return null;
  const buf = readZipEntry(zipBuf, entry);
  return buf ? expandSelfClosingTags(buf.toString('utf8')) : null;
}

// EPUB chapters are XHTML, where <a id="chap03"/> is an empty element. The
// Reader parses them as HTML (forgiving of broken books), and HTML ignores
// the "/>" on anything but a void element, so that one anchor swallowed the
// whole rest of the chapter: every paragraph became link text, drawn in the
// theme's link colour and underlined. Project Gutenberg books all do this
// (fix v0.19.1, found while making the README screenshots). Rewrites
// <tag .../> as <tag ...></tag> for every non-void element; void elements
// (<br/>, <img/>, ...) are already fine and are left alone.
const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function expandSelfClosingTags(html) {
  return String(html).replace(/<([A-Za-z][\w:.-]*)(\s(?:[^<>"']|"[^"]*"|'[^']*')*?)?\s*\/>/g, (m, tag, attrs) => (
    HTML_VOID_TAGS.has(tag.toLowerCase()) ? m : `<${tag}${attrs || ''}></${tag}>`
  ));
}

// extractNavToc — EPUB3 nav document: the <nav epub:type="toc">...</nav>
// list of <a href="chapter.xhtml#frag">Title</a> entries, in reading order.
function extractNavToc(navHtml) {
  const navMatch = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(navHtml);
  const scope = navMatch ? navMatch[1] : navHtml;
  const entries = [];
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(scope)) !== null) {
    const href = (xmlAttr(m[1], 'href') || '').split('#')[0];
    const title = decodeXmlEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (href && title) entries.push({ href, title });
  }
  return entries;
}

// extractNcxToc — EPUB2 NCX <navMap> only (explicitly NOT the <pageList>
// that a Project-Gutenberg-style NCX also carries -- that block reuses the
// exact same <navLabel>/<content> shape but one entry per *print* page,
// hundreds of them, which would swamp a real chapter list).
function extractNcxToc(ncxXml) {
  const navMapMatch = /<navMap\b[^>]*>([\s\S]*?)<\/navMap>/i.exec(ncxXml);
  const scope = navMapMatch ? navMapMatch[1] : '';
  const entries = [];
  const re = /<navLabel>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(scope)) !== null) {
    const title = decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim();
    const href = (xmlAttr(m[2], 'src') || '').split('#')[0];
    if (title && href) entries.push({ href, title });
  }
  return entries;
}

// getEpubToc — real table of contents (title + which spine file it starts
// at), preferring an EPUB3 nav document (manifest item with
// properties="nav") and falling back to the EPUB2 NCX (the manifest item
// whose media-type is the NCX one). Returns [] if the book has neither (the
// caller falls back to counting spine items instead).
function getEpubToc(zipBuf) {
  try {
    const located = locateOpf(zipBuf);
    if (!located) return [];
    const itemRe = /<item\b([^>]*)\/?>/gi;
    let m; let navHref = null; let ncxHref = null;
    while ((m = itemRe.exec(located.opfXml)) !== null) {
      const attrs = m[1];
      const href = xmlAttr(attrs, 'href');
      const properties = xmlAttr(attrs, 'properties') || '';
      const mediaType = xmlAttr(attrs, 'media-type') || '';
      if (href && properties.split(/\s+/).includes('nav')) navHref = href;
      if (href && /ncx/i.test(mediaType)) ncxHref = href;
    }
    const load = (href) => {
      const resolved = posixJoinNormalize(located.opfDir, href);
      const entry = resolved ? located.entries.get(resolved) : null;
      const xml = entry ? readZipEntry(zipBuf, entry)?.toString('utf8') : null;
      const dir = resolved && resolved.includes('/') ? resolved.slice(0, resolved.lastIndexOf('/')) : '.';
      return xml ? { xml, dir } : null;
    };
    if (navHref) {
      const loaded = load(navHref);
      if (loaded) {
        const raw = extractNavToc(loaded.xml);
        const list = raw.map((e) => ({ title: e.title, resolvedPath: posixJoinNormalize(loaded.dir, e.href) })).filter((e) => e.resolvedPath);
        if (list.length) return list;
      }
    }
    if (ncxHref) {
      const loaded = load(ncxHref);
      if (loaded) {
        const raw = extractNcxToc(loaded.xml);
        const list = raw.map((e) => ({ title: e.title, resolvedPath: posixJoinNormalize(loaded.dir, e.href) })).filter((e) => e.resolvedPath);
        if (list.length) return list;
      }
    }
  } catch { /* fall through to spine-count fallback at the call site */ }
  return [];
}

// buildTocChapterList — TOC entries resolved to spine indices, in ascending
// order, collapsing consecutive entries that land on the same spine file
// (a TOC that anchors several sub-sections within one physical chapter
// file) down to their first occurrence.
function buildTocChapterList(tocEntries, spine) {
  const list = [];
  for (const t of tocEntries) {
    const idx = spine.findIndex((s) => s.resolvedPath === t.resolvedPath);
    if (idx === -1) continue;
    if (list.length && list[list.length - 1].idx === idx) continue;
    list.push({ idx, title: t.title });
  }
  return list;
}

// findChapterForSpineIdx — which TOC chapter (1-based, out of the total
// count of resolvable TOC chapters) a given spine index falls under. Returns
// null for a spine index before the first TOC chapter (front matter: cover,
// title page, etc. that the TOC itself doesn't list).
function findChapterForSpineIdx(chapters, idx) {
  if (!chapters.length) return null;
  let best = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].idx <= idx) best = i; else break;
  }
  if (best === -1) return null;
  return { number: best + 1, total: chapters.length, title: chapters[best].title };
}

// estimateSpineIdxFromPercent — fallback for book notes whose last_cfi isn't
// in this plugin's own "spine:<N>" format (e.g. a real epubcfi(...) carried
// over from A3's finer-grained reader on migration). Rather than always
// falling back to spine index 0 -- which reopens every migrated book on its
// cover page regardless of real progress -- estimate a spine index
// proportional to progress_percent, weighted by each spine item's actual
// byte size (chapters vary wildly in length, so an index-count average
// would be far less accurate than a size-weighted one).
function estimateSpineIdxFromPercent(spine, entries, percent) {
  if (!Array.isArray(spine) || !spine.length || typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0) return 0;
  const sizes = spine.map((s) => entries.get(s.resolvedPath)?.uncompressedSize || 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const target = Math.min(total, (Math.max(0, Math.min(100, percent)) / 100) * total);
  let cumulative = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    cumulative += sizes[i];
    if (cumulative >= target) return i;
  }
  return spine.length - 1;
}

// computeEpubProgressPercent — inverse of estimateSpineIdxFromPercent: turns
// a spine index + page-within-chapter position into an overall percent
// through the book, still weighted by each spine item's real byte size (a
// one-page front-matter chapter and a 150KB chapter both count as "1 spine
// item" otherwise, which would badly skew the percentage).
function computeEpubProgressPercent(spine, entries, idx, pageCountInChapter, page) {
  if (!Array.isArray(spine) || !spine.length || !entries) return 0;
  const sizes = spine.map((s) => entries.get(s.resolvedPath)?.uncompressedSize || 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!total) return spine.length ? (idx / spine.length) * 100 : 0;
  let before = 0;
  for (let i = 0; i < idx; i += 1) before += sizes[i];
  const withinFraction = pageCountInChapter > 0 ? Math.min(1, Math.max(0, page) / pageCountInChapter) : 0;
  const withinBytes = (sizes[idx] || 0) * withinFraction;
  return Math.min(100, ((before + withinBytes) / total) * 100);
}

// isFootnoteMarkerAnchor — is this <a> a footnote/endnote reference marker
// rather than real book text? Two shapes recognized: the EPUB3 standard
// (epub:type="noteref"), and Project Gutenberg's own convention (an
// "fnanchor"/"canchor" class paired with "pginternal", or an id starting
// "FNanchor"/"Footnote"/"Canchor"/"Note") -- confirmed against this book's
// own real markup, which uses the latter. A short, internally-linked anchor
// (href has a "#" fragment, visible text under 10 characters) with no other
// signal is treated as a plain, harmless link and left alone -- this check
// only fires on the marker conventions actually seen, not on text length
// alone, so an ordinary short in-book link isn't swallowed by mistake.
function isFootnoteMarkerAnchor(a) {
  const cls = (a.getAttribute('class') || '').toLowerCase();
  const id = (a.getAttribute('id') || '').toLowerCase();
  const epubType = (a.getAttribute('epub:type') || '').toLowerCase();
  if (epubType.split(/\s+/).includes('noteref')) return true;
  if (/\b(fnanchor|canchor)\b/.test(cls)) return true;
  if (/^(fnanchor|footnote|endnote|canchor|note)/.test(id)) return true;
  return false;
}

// splitIntoSentences — walks plain chapter text (already flattened from the
// DOM, one string) and returns [{ text, start, end }] where start/end are
// character offsets into that same string. Used by the Listen feature to
// speak one sentence at a time and to map each sentence back to a DOM range
// (see ReadingView.rangeFromOffsets). Handles common abbreviations (Mr.,
// Dr., etc., single-capital initials like "J.") and mid-sentence periods
// (e.g. "e.g." or a decimal) by requiring the character after the
// whitespace following a sentence-ending punctuation run to look like the
// start of a new sentence (uppercase/digit/quote/paren) — "reasonably", not
// perfectly, per the build brief.
const SENTENCE_ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'vol', 'fig', 'approx', 'cf', 'al', 'ca', 'pp']);
function splitIntoSentences(text) {
  if (!text) return [];
  const isAbbrevBefore = (idx) => {
    const before = text.slice(Math.max(0, idx - 12), idx);
    const m = /([A-Za-z]+\.?[A-Za-z]*)$/.exec(before);
    if (!m) return false;
    const word = m[1].replace(/\.$/, '').toLowerCase();
    return SENTENCE_ABBR.has(word) || /^[A-Z]$/.test(m[1]);
  };
  const boundaries = [];
  const re = /[.!?]+(["'’”)\]]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const punctEnd = m.index + m[0].length;
    let after = punctEnd;
    while (after < text.length && /\s/.test(text[after])) after += 1;
    // Only a full stop can end an abbreviation: "No!" and "Dr?" end their
    // sentence (QA fix v0.17.3). "No." "Vol." "Fig." "pp." only count as
    // abbreviations before a number ("No. 5"), so "I said no. He left."
    // is two sentences.
    if (m[0][0] === '.' && isAbbrevBefore(m.index)) {
      const word = (/([A-Za-z]+)$/.exec(text.slice(Math.max(0, m.index - 12), m.index)) || [])[1] || '';
      const numbering = ['no', 'vol', 'fig', 'pp'].includes(word.toLowerCase());
      if (!numbering || /\d/.test(text[after] || '')) continue;
    }
    if (after < text.length && /[a-z]/.test(text[after])) continue;
    boundaries.push(after);
  }
  const sentences = [];
  let start = 0;
  const pushRange = (s0, e0) => {
    const raw = text.slice(s0, e0);
    const leading = raw.match(/^\s*/)[0].length;
    const trailing = raw.match(/\s*$/)[0].length;
    const s = s0 + leading;
    const e = e0 - trailing;
    if (e > s) sentences.push({ text: text.slice(s, e), start: s, end: e });
  };
  for (const b of boundaries) {
    if (b <= start) continue;
    pushRange(start, b);
    start = b;
  }
  if (start < text.length) pushRange(start, text.length);
  return sentences;
}

// ---------------------------------------------------------------------------
// PDF — heuristic page count + Info-dictionary Title/Author (regex reads
// over untrusted bytes, no PDF library; same "hand-rolled, builtins only"
// posture as the EPUB parser above).
// ---------------------------------------------------------------------------
function estimatePdfPageCount(buf) {
  try {
    const text = buf.toString('latin1');
    const matches = text.match(/\/Type\s*\/Page(?!s)\b/g);
    return matches ? matches.length : null;
  } catch { return null; }
}

// One PDF string starting at text[i] ('(' literal or '<' hex), as raw bytes
// in a latin1 string. Literal strings may hold balanced ( ) and \ escapes,
// including \ddd octal.
function readPdfStringAt(text, i) {
  if (text[i] === '<' && text[i + 1] !== '<') {
    const end = text.indexOf('>', i);
    if (end < 0) return null;
    let hex = text.slice(i + 1, end).replace(/[^0-9a-f]/gi, '');
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
    return out;
  }
  if (text[i] !== '(') return null;
  let depth = 0; let out = '';
  for (let k = i; k < text.length && k < i + 20000; k += 1) {
    const c = text[k];
    if (c === '\\') {
      const n = text[k + 1];
      const oct = /^[0-7]{1,3}/.exec(text.slice(k + 1, k + 4));
      if (oct) { out += String.fromCharCode(parseInt(oct[0], 8) & 0xff); k += oct[0].length; continue; }
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (n === '\r' || n === '\n') { k += (n === '\r' && text[k + 2] === '\n') ? 2 : 1; continue; }
      out += map[n] !== undefined ? map[n] : (n || '');
      k += 1;
      continue;
    }
    if (c === '(') { depth += 1; if (depth === 1) continue; }
    if (c === ')') { depth -= 1; if (depth === 0) return out; }
    out += c;
  }
  return null;
}

// PDF text strings are UTF-16 (with a byte-order mark), or a Latin-style
// single-byte encoding.
function pdfBytesToText(bytes) {
  const b = Buffer.from(bytes, 'latin1');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const body = b.subarray(2, 2 + ((b.length - 2) & ~1));
    const le = Buffer.alloc(body.length);
    for (let k = 0; k + 1 < body.length; k += 2) { le[k] = body[k + 1]; le[k + 1] = body[k]; }
    return le.toString('utf16le');
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return bytes;
}

function cleanPdfMetaText(s) {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[\u0000-\u001f\u007f�]+/g, ' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/^Microsoft (?:Word|PowerPoint) - /i, '').replace(/\.(?:docx?|pptx?|rtf|odt|pages)$/i, '').trim();
  if (!out || /^(?:untitled|unknown|none|null|title)$/i.test(out)) return null;
  return out;
}

// A field of the PDF's own document information (Title, Author, Subject).
// QA fix v0.17.3: read it from the document's info record that the file's
// trailer points to, never from the first "/Title" anywhere in the file,
// which is often a bookmark ("Chapter 1", "Cover"). Falls back to the
// file's XMP metadata; null when neither says.
function extractPdfInfoField(buf, field) {
  try {
    const text = buf.toString('latin1');
    const refs = [...text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R\b/g)];
    for (let r = refs.length - 1; r >= 0; r -= 1) {
      const objRe = new RegExp(`(?:^|[^0-9])${refs[r][1]}\\s+${refs[r][2]}\\s+obj\\b`, 'g');
      let m; let at = -1;
      while ((m = objRe.exec(text)) !== null) at = m.index;
      if (at < 0) continue;
      const end = text.indexOf('endobj', at);
      const body = text.slice(at, end < 0 ? at + 20000 : end);
      const fm = new RegExp(`/${field}\\s*([(<])`).exec(body);
      if (!fm) return extractPdfXmpField(text, field);
      const raw = readPdfStringAt(body, fm.index + fm[0].length - 1);
      const val = raw === null ? null : cleanPdfMetaText(pdfBytesToText(raw));
      return val || extractPdfXmpField(text, field);
    }
    return extractPdfXmpField(text, field);
  } catch { return null; }
}

function extractPdfXmpField(text, field) {
  const tag = { Title: 'title', Author: 'creator', Subject: 'description' }[field];
  if (!tag) return null;
  const m = new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'i').exec(text);
  if (!m) return null;
  const li = /<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(m[1]);
  const inner = (li ? li[1] : m[1]).replace(/<[^>]+>/g, '');
  let decoded = inner;
  try { decoded = Buffer.from(inner, 'latin1').toString('utf8'); } catch { /* keep */ }
  return cleanPdfMetaText(decodeXmlEntities(decoded));
}

// ---------------------------------------------------------------------------
// ReadingStore — the data-access layer. All reads/writes go through
// Obsidian's own vault/metadataCache/fileManager APIs (never raw fs) since
// every file this plugin touches is inside the vault.
// ---------------------------------------------------------------------------
class ReadingStore {
  // `plugin` is optional (a few call sites build a throwaway ReadingStore
  // just to read book/highlight lists) but required for anything that
  // writes the Highlights-in-book-note section, since that needs the live
  // `highlightsInBookNote` setting.
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin || null;
    this._hlSyncTimers = new Map(); // book path -> timer id, debounces a burst of highlight edits into one write
  }

  async ensureFolders() {
    await ensureFolder(this.app, READING_DIR);
    await ensureFolder(this.app, HIGHLIGHTS_DIR);
    await ensureFolder(this.app, TOPICS_DIR);
    const parts = FILES_DIR.split('/');
    for (let i = 1; i <= parts.length; i += 1) await ensureFolder(this.app, parts.slice(0, i).join('/'));
    await ensureFolder(this.app, BOOKS_ASSET_DIR);
    await ensureFolder(this.app, COVERS_ASSET_DIR);
  }

  listBookFiles() {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${READING_DIR}/`)
        && !f.path.startsWith(`${HIGHLIGHTS_DIR}/`)
        && !f.path.startsWith(`${WORDS_DIR}/`) // saved words aren't books (v0.17.2)
        && f.path !== LANDING_NOTE
        && this.isBookNote(f));
  }

  // Only notes Reading Vault made for a book count as books (QA fix v0.17.3):
  // any other note kept in the Reading folder used to show in the Library
  // and got a Highlights section added. A note with no frontmatter read yet
  // (just created) is let through until Obsidian has read it.
  isBookNote(f) {
    const cache = this.app.metadataCache.getFileCache(f);
    if (!cache) return true;
    const fm = cache.frontmatter || {};
    return fm.type === 'book' || (!fm.type && !!fm.file_path);
  }

  getFm(file) {
    return (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
  }

  // Title and author always come back as plain text (QA fix v0.17.3): a
  // list or number typed in Obsidian's Properties panel used to blank the
  // whole Library.
  listBooks() {
    return this.listBookFiles().map((file) => {
      const fm = this.getFm(file);
      return { file, ...fm, title: fmText(fm.title), author: fmText(fm.author) };
    });
  }

  // Also finds a book added moments ago, before Obsidian has read its new
  // note (QA fix v0.17.3: the same file picked twice in one go was added
  // twice).
  findBookBySha(sha256) {
    const recent = this._justAdded && this._justAdded.get(sha256);
    if (recent && this.app.vault.getAbstractFileByPath(recent.path)) return { file: recent, file_sha256: sha256 };
    return this.listBooks().find((b) => b.file_sha256 === sha256) || null;
  }

  async createBookFromBuffer(buf, guessTitle) {
    await this.ensureFolders();
    const format = sniffBookFormat(buf);
    if (!format) return { ok: 'bad-book' };

    const sha256 = sha256Hex(buf);
    const dup = this.findBookBySha(sha256);
    if (dup) return { ok: 'duplicate', file: dup.file };

    let metaTitle = null; let metaAuthor = null; let coverInfo = null; let pageCount = null;
    if (format === 'epub') {
      metaTitle = extractEpubTitle(buf);
      metaAuthor = extractEpubAuthor(buf);
      coverInfo = extractEpubCover(buf);
      const spine = getEpubSpine(buf);
      pageCount = spine ? spine.spine.length : null; // "pages" = chapter count for epub
    } else {
      metaTitle = extractPdfInfoField(buf, 'Title');
      metaAuthor = extractPdfInfoField(buf, 'Author');
      pageCount = estimatePdfPageCount(buf);
    }
    const description = extractBookDescription(buf, format);

    let title = (metaTitle && metaTitle.trim()) || guessTitle || format.toUpperCase();
    title = title.replace(/[_-]+/g, (m2) => (title === title.toLowerCase() || title === title.toUpperCase() ? ' ' : m2)).trim();
    const author = (metaAuthor && metaAuthor.trim()) || '';

    const uuid = crypto.randomUUID();
    const bookAssetPath = `${BOOKS_ASSET_DIR}/${uuid}.${format}`;
    await this.app.vault.createBinary(bookAssetPath, bufToArrayBuffer(buf));

    let coverAssetPath = null;
    if (coverInfo) {
      const coverUuid = crypto.randomUUID();
      coverAssetPath = `${COVERS_ASSET_DIR}/${coverUuid}.${coverInfo.ext}`;
      await this.app.vault.createBinary(coverAssetPath, bufToArrayBuffer(coverInfo.buf));
    }

    // Anything going wrong from here on takes the copied book file and
    // cover away again, so a failed import leaves nothing behind.
    const cleanUp = async () => {
      for (const p of [bookAssetPath, coverAssetPath]) {
        const f = p ? this.app.vault.getAbstractFileByPath(p) : null;
        if (f) { try { await this.app.vault.delete(f); } catch { /* already gone */ } }
      }
    };
    try {
      const notePath = await uniqueVaultPath(this.app, READING_DIR, sanitizeFilename(title), 'md');
      const fmLines = [
        '---',
        'type: book',
        `title: "${escapeYaml(title)}"`,
        `author: "${escapeYaml(author)}"`,
        'status: "to-read"',
        'tags: []',
        `format: "${format}"`,
        `file_path: "${bookAssetPath}"`,
        coverAssetPath ? `cover_path: "${coverAssetPath}"` : 'cover_path: null',
        `page_count: ${pageCount == null ? 'null' : pageCount}`,
        `file_sha256: "${sha256}"`,
        'last_page: null',
        'last_cfi: null',
        'progress_percent: null',
        'progress_updated_at: null',
        'listen_pos: null',
        ...(description ? ['summary_source: "book"'] : []),
        '---',
        '',
        ...(description ? ['## Summary', '', description, ''] : []),
        '## Notes',
        '',
        '',
      ];
      const file = await this.app.vault.create(notePath, fmLines.join('\n'));
      if (!this._justAdded) this._justAdded = new Map();
      this._justAdded.set(sha256, file);
      return { ok: 'created', file };
    } catch (err) {
      await cleanUp();
      throw err;
    }
  }

  async updateBookFields(file, fields) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      Object.assign(fm, fields);
    });
  }

  async setTags(file, tags) {
    await this.updateBookFields(file, { tags });
  }

  // Add or remove one tag against what the note says right now, not what
  // the page last showed (QA fix v0.17.3: two quick changes could undo each
  // other because the second was built from the stale list).
  async addTag(file, tag) {
    const v = String(tag || '').trim().replace(/^#/, '');
    if (!v) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const list = normTagList(fm.tags);
      if (!list.includes(v)) list.push(v);
      fm.tags = list;
    });
  }

  async removeTag(file, tag) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.tags = normTagList(fm.tags).filter((x) => x !== tag);
    });
  }

  async uploadCover(file, buf) {
    const ext = sniffImageExt(buf);
    if (!ext) return { ok: 'bad-image' };
    await this.ensureFolders();
    const fm = this.getFm(file);
    const oldCover = fm.cover_path;
    const uuid = crypto.randomUUID();
    const coverAssetPath = `${COVERS_ASSET_DIR}/${uuid}.${ext}`;
    await this.app.vault.createBinary(coverAssetPath, bufToArrayBuffer(buf));
    await this.updateBookFields(file, { cover_path: coverAssetPath });
    if (oldCover) {
      const old = this.app.vault.getAbstractFileByPath(oldCover);
      if (old) { try { await this.app.vault.delete(old); } catch { /* best-effort */ } }
    }
    return { ok: 'updated', coverAssetPath };
  }

  async deleteBook(file) {
    const fm = this.getFm(file);
    const bookAsset = fm.file_path ? this.app.vault.getAbstractFileByPath(fm.file_path) : null;
    const coverAsset = fm.cover_path ? this.app.vault.getAbstractFileByPath(fm.cover_path) : null;
    // Also delete this book's highlight notes (soft-ref by book_path).
    const hls = this.listHighlightFiles(file.path);
    for (const hf of hls) { try { await this.app.vault.delete(hf); } catch { /* best-effort */ } }
    if (bookAsset) { try { await this.app.vault.delete(bookAsset); } catch { /* best-effort */ } }
    if (coverAsset) { try { await this.app.vault.delete(coverAsset); } catch { /* best-effort */ } }
    await this.app.vault.delete(file);
  }

  // The book note's own "## Notes" section: from that heading up to the
  // next "## " heading. Stopping there matters -- the auto-maintained
  // "## Highlights" section (and v0.10.0's "## Questions") come after it,
  // and reading to the end of the file showed that generated text in the
  // Detail page's Notes box as if the reader had written it (fixed v0.11.0,
  // from John's screenshot 2026-09-24).
  async getNotesBody(file) {
    return readNoteSection(await this.app.vault.read(file), 'Notes');
  }

  // Replaces ONLY the Notes section's text; everything before it and every
  // section after it (Questions, Highlights) stays byte-for-byte. A note with
  // no Notes heading gets one above Questions/Highlights, never after them,
  // so the Highlights section stays last (see syncHighlightsSection).
  async setNotesBody(file, text) {
    const body = `## Notes\n\n${guardReservedHeadings(String(text || '').trim())}\n`;
    // Read and write in one step, so two saves to the same note can't
    // overwrite each other (QA fix v0.17.3).
    await this.app.vault.process(file, (content) => {
    const sec = findNoteSection(content, 'Notes');
    let next;
    if (sec) {
      const head = content.slice(0, sec.start).trimEnd();
      const tail = content.slice(sec.end);
      next = `${head ? `${head}\n\n` : ''}${body}${tail ? `\n${tail}` : ''}`;
    } else {
      const later = /^## (Questions|Highlights)[ \t]*$/m.exec(content);
      if (later) {
        const head = content.slice(0, later.index).trimEnd();
        next = `${head ? `${head}\n\n` : ''}${body}\n${content.slice(later.index)}`;
      } else {
        next = `${content.trimEnd()}\n\n${body}`;
      }
    }
    return next;
    });
  }

  // Book summary (v0.14.0): the text lives in the note's "## Summary"
  // section; where it came from ("book", "ai" or "you") and, for AI, which
  // model and when, live in the frontmatter so the Detail page can say so.
  async getSummary(file) {
    const content = await this.app.vault.read(file);
    const fm = this.getFm(file);
    return { text: readNoteSection(content, 'Summary'), source: fm.summary_source || null, ai: fm.summary_ai || null };
  }

  async setSummary(file, text, { source, ai } = {}) {
    const clean = String(text || '').trim();
    await this.app.vault.process(file, (content) => writeSummarySection(content, clean));
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (!clean) { delete fm.summary_source; delete fm.summary_ai; return; }
      fm.summary_source = source || 'you';
      if (source === 'ai' && ai) fm.summary_ai = ai; else delete fm.summary_ai;
    });
  }

  // Never write (and never bump progress_updated_at) when every field is
  // already what the frontmatter already says -- a no-op write still
  // triggers a full processFrontMatter rewrite, a metadataCache reparse,
  // and an Obsidian Sync upload of the whole book note, which is exactly
  // what was hammering CPU/Sync during Listen (see the v0.2.5 journal
  // entry). Only real changes reach disk.
  async saveProgress(file, fields) {
    const fm = this.getFm(file);
    const changed = Object.keys(fields).some((k) => fm[k] !== fields[k]);
    if (!changed) return;
    await this.updateBookFields(file, { ...fields, progress_updated_at: new Date().toISOString() });
  }

  // -------------------- Bookmarks --------------------
  // Stored on the book note's own frontmatter, next to last_page/last_cfi --
  // the same per-book-state pattern this plugin already uses, per
  // GL-002's `book` row. `location` reuses last_cfi's own
  // "spine:<idx>:page:<page>:of:<total>" string for epub (so a bookmark can
  // be resumed through the exact same pendingPageFraction machinery the
  // reader already uses to resume normal reading progress) or a plain page
  // number for pdf.
  // Each of these returns the resulting `bookmarks` array straight out of the
  // `processFrontMatter` callback rather than making the caller re-read it
  // via `getFm()`/`metadataCache` right afterward -- the metadata cache's
  // 'changed' re-parse is not guaranteed to have landed by the time this
  // promise resolves, so an immediate re-read can hand back the stale
  // pre-edit array (this was the delete-does-nothing bug: the row was
  // removed on disk but the very next render read the old cached list).
  async addBookmark(file, { label, location, format }) {
    const bookmark = { id: crypto.randomUUID(), label: label || null, location, format, created: new Date().toISOString() };
    let bookmarks;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (!Array.isArray(fm.bookmarks)) fm.bookmarks = [];
      fm.bookmarks.push(bookmark);
      bookmarks = fm.bookmarks;
    });
    return { bookmark, bookmarks };
  }

  async removeBookmark(file, id) {
    let bookmarks;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.bookmarks = Array.isArray(fm.bookmarks) ? fm.bookmarks.filter((b) => b.id !== id) : [];
      bookmarks = fm.bookmarks;
    });
    return bookmarks;
  }

  async updateBookmarkLabel(file, id, label) {
    let bookmarks;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (!Array.isArray(fm.bookmarks)) fm.bookmarks = [];
      const bm = fm.bookmarks.find((b) => b.id === id);
      if (bm) bm.label = label ? label.trim() : null;
      bookmarks = fm.bookmarks;
    });
    return bookmarks;
  }

  // -------------------- Saved words (v0.13.0) --------------------
  // One note per word in Reading/Words, linked to the book (approved
  // mockup-word-lookup.html). Saving a word that already has a note adds this
  // book's sentence to it instead of making a second note.
  //
  // A word can belong to several books (John, 2026-09-25): book_path is the
  // book it was first saved from (unchanged), and book_paths lists every
  // book it has been saved from, added the first time it's saved from a
  // second book. The word shows on each of those books' pages.
  static wordBookPaths(fm) {
    const out = [];
    for (const p of [fm && fm.book_path, ...(Array.isArray(fm && fm.book_paths) ? fm.book_paths : [])]) {
      if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  listWordFiles(bookPath) {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${WORDS_DIR}/`))
      .filter((f) => {
        const fm = this.getFm(f);
        return fm.type === 'vocab_word' && (!bookPath || ReadingStore.wordBookPaths(fm).includes(bookPath));
      })
      .sort((a, b) => String(this.getFm(a).word || a.basename).localeCompare(String(this.getFm(b).word || b.basename)));
  }

  async saveWord({ word, meaning, bookFile, quote, explanation }) {
    await ensureFolder(this.app, WORDS_DIR);
    const clean = String(word).trim();
    const name = sanitizeFilename(clean.toLowerCase());
    const path = `${WORDS_DIR}/${name}.md`;
    const bookLink = `[[${bookFile.basename}]]`;
    const lines = [];
    if (quote) lines.push(`**In ${bookLink}:** "${String(quote).replace(/\s+/g, ' ').trim()}"`);
    else lines.push(`**In ${bookLink}**`);
    if (explanation) lines.push('', `**In this sentence:** ${String(explanation).trim()}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (text) => `${text.replace(/\s+$/, '')}\n\n${lines.join('\n')}\n`);
      // Saved from another book: the word belongs to that book too.
      await this.app.fileManager.processFrontMatter(existing, (fm) => {
        const paths = ReadingStore.wordBookPaths(fm);
        if (!paths.includes(bookFile.path)) fm.book_paths = [...paths, bookFile.path];
      });
      return { file: existing, existed: true };
    }
    const content = [
      '---',
      'type: vocab_word',
      `word: "${escapeYaml(clean)}"`,
      `book_path: "${escapeYaml(bookFile.path)}"`,
      `saved_at: ${localDayKey(new Date())}`,
      '---',
      '',
      `# ${clean}`,
      '',
      meaning ? `**Meaning:** ${String(meaning).trim()}` : '',
      meaning ? '' : null,
      ...lines,
      '',
    ].filter((l) => l !== null).join('\n');
    const file = await this.app.vault.create(path, content);
    return { file, existed: false };
  }

  // -------------------- Shelves (v0.12.0) --------------------
  // See the notes above SHELF_NAME_MAX for where each piece is kept.
  shelfSettings() {
    const s = this.plugin && this.plugin.settings;
    return s && Array.isArray(s.shelves) ? s.shelves : [];
  }

  async saveShelfSettings(list) {
    if (!this.plugin) return;
    this.plugin.settings.shelves = list; // always a fresh array, never the shared default
    await this.plugin.saveSettings();
  }

  // Every shelf, by name: [{ name, order }]. Includes a name found only in a
  // book note's own `shelves` (typed there by hand).
  listShelves() {
    const out = this.shelfSettings().map((s) => ({ name: cleanShelfName(s.name), order: Array.isArray(s.order) ? s.order.slice() : [] })).filter((s) => s.name);
    for (const b of this.listBooks()) {
      for (const n of normShelfList(b.shelves)) {
        if (!out.some((s) => s.name.toLowerCase() === n.toLowerCase())) out.push({ name: n, order: [] });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  findShelf(name) {
    const n = cleanShelfName(name).toLowerCase();
    return this.listShelves().find((s) => s.name.toLowerCase() === n) || null;
  }

  booksOnShelf(name) {
    const shelf = this.findShelf(name);
    if (!shelf) return [];
    const n = shelf.name.toLowerCase();
    return sortByShelfOrder(this.listBooks().filter((b) => normShelfList(b.shelves).some((x) => x.toLowerCase() === n)), shelf.order);
  }

  // Returns the new shelf's name, or null when the name is empty or taken.
  async createShelf(name) {
    const n = cleanShelfName(name);
    if (!n || this.findShelf(n)) return null;
    await this.saveShelfSettings([...this.shelfSettings(), { name: n, order: [] }]);
    return n;
  }

  async addBookToShelf(file, name) {
    const n = cleanShelfName(name);
    if (!n) return;
    const shelf = this.findShelf(n);
    const real = shelf ? shelf.name : n;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const list = normShelfList(fm.shelves);
      if (!list.some((x) => x.toLowerCase() === real.toLowerCase())) list.push(real);
      fm.shelves = list;
    });
    // A book already on the shelf keeps its place there (QA fix v0.17.3:
    // dropping it on its own shelf again moved it to the end).
    if (shelf && (shelf.order || []).includes(file.path)) return;
    const settings = this.shelfSettings().filter((s) => s.name.toLowerCase() !== real.toLowerCase());
    const order = shelf ? shelf.order.filter((p) => p !== file.path) : [];
    await this.saveShelfSettings([...settings, { name: real, order: [...order, file.path] }]);
  }

  async removeBookFromShelf(file, name) {
    const n = cleanShelfName(name).toLowerCase();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const list = normShelfList(fm.shelves).filter((x) => x.toLowerCase() !== n);
      if (list.length) fm.shelves = list; else delete fm.shelves;
    });
    await this.saveShelfSettings(this.shelfSettings().map((s) => (s.name.toLowerCase() === n ? { ...s, order: (s.order || []).filter((p) => p !== file.path) } : s)));
  }

  // Renames everywhere: the shelf list and every book note that has it.
  // Returns false when the new name is empty or already another shelf's.
  async renameShelf(oldName, newName) {
    const from = cleanShelfName(oldName);
    const to = cleanShelfName(newName);
    const shelf = this.findShelf(from);
    if (!shelf || !to) return false;
    const other = this.findShelf(to);
    if (other && other.name.toLowerCase() !== from.toLowerCase()) return false;
    for (const b of this.booksOnShelf(from)) {
      // eslint-disable-next-line no-await-in-loop -- one shelf's books, one write each
      await this.app.fileManager.processFrontMatter(b.file, (fm) => {
        fm.shelves = normShelfList(fm.shelves).map((x) => (x.toLowerCase() === from.toLowerCase() ? to : x));
      });
    }
    const rest = this.shelfSettings().filter((s) => cleanShelfName(s.name).toLowerCase() !== from.toLowerCase());
    await this.saveShelfSettings([...rest, { name: to, order: shelf.order }]);
    return true;
  }

  // Takes the shelf off every book and forgets it. Never deletes a book.
  async deleteShelf(name) {
    const n = cleanShelfName(name).toLowerCase();
    for (const b of this.booksOnShelf(name)) {
      // eslint-disable-next-line no-await-in-loop -- one shelf's books, one write each
      await this.app.fileManager.processFrontMatter(b.file, (fm) => {
        const list = normShelfList(fm.shelves).filter((x) => x.toLowerCase() !== n);
        if (list.length) fm.shelves = list; else delete fm.shelves;
      });
    }
    await this.saveShelfSettings(this.shelfSettings().filter((s) => cleanShelfName(s.name).toLowerCase() !== n));
  }

  async setShelfOrder(name, paths) {
    const shelf = this.findShelf(name);
    if (!shelf) return;
    const rest = this.shelfSettings().filter((s) => cleanShelfName(s.name).toLowerCase() !== shelf.name.toLowerCase());
    await this.saveShelfSettings([...rest, { name: shelf.name, order: paths.slice() }]);
  }

  // -------------------- Highlights --------------------
  listHighlightFiles(bookPath) {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${HIGHLIGHTS_DIR}/`))
      .filter((f) => {
        if (!bookPath) return true;
        const fm = this.getFm(f);
        return fm.book_path === bookPath;
      });
  }

  listHighlights(bookPath) {
    return this.listHighlightFiles(bookPath)
      .map((file) => ({ file, ...this.getFm(file) }))
      .sort((a, b) => String(a.highlighted_at || '').localeCompare(String(b.highlighted_at || '')));
  }

  async createHighlight({ bookFile, format, locationPage, locationCfi, excerpt, color }) {
    await this.ensureFolders();
    const bookFm = this.getFm(bookFile);
    const highlightedAt = new Date().toISOString();
    const base = `${sanitizeFilename(bookFile.basename)} - ${highlightedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    const notePath = await uniqueVaultPath(this.app, HIGHLIGHTS_DIR, base, 'md');
    const lines = [
      '---',
      'type: book_highlight',
      `book_title: "${escapeYaml(bookFm.title || bookFile.basename)}"`,
      `book_path: "${escapeYaml(bookFile.path)}"`,
      `book_slug: ${bookFm.book_slug ? `"${escapeYaml(bookFm.book_slug)}"` : 'null'}`,
      `format: "${format}"`,
      `location_page: ${format === 'pdf' && locationPage != null ? locationPage : 'null'}`,
      format === 'epub' && locationCfi ? `location_cfi: "${escapeYaml(locationCfi)}"` : 'location_cfi: null',
      `excerpt: "${escapeYaml(excerpt)}"`,
      `highlighted_at: "${highlightedAt}"`,
      'status: "pending"',
      'topic_slug: null',
      'topic_path: null',
      color ? `color: "${color}"` : 'color: null',
      'note: null',
      '---',
      '',
    ];
    const file = await this.app.vault.create(notePath, lines.join('\n'));
    this.scheduleHighlightsSync(bookFile);
    return file;
  }

  listTopicFiles() {
    return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${TOPICS_DIR}/`));
  }

  async ensureTopic(title) {
    const cleanTitle = title.trim();
    const existing = this.listTopicFiles().find((f) => f.basename.toLowerCase() === cleanTitle.toLowerCase());
    if (existing) return existing;
    await ensureFolder(this.app, TOPICS_DIR);
    const notePath = await uniqueVaultPath(this.app, TOPICS_DIR, sanitizeFilename(cleanTitle), 'md');
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      '---',
      'type: topic',
      `created: ${today}`,
      'related_topics: []',
      'tags: []',
      '---',
      '',
      `# ${cleanTitle}`,
      '',
      '## What I think about here',
      '',
      '',
      '## Open questions',
      '',
      '',
      '## Graduation',
      '',
      'If this Topic grows into a permanent domain of your life, it graduates into a Key Element. Leave this section empty while the Topic is still exploring.',
      '',
      '## Sources',
      '',
      'Books, articles, people, conversations that shaped your thinking on this topic. Link to them.',
      '',
    ].join('\n');
    return this.app.vault.create(notePath, content);
  }

  async linkHighlight(hlFile, topicTitle) {
    const topicFile = await this.ensureTopic(topicTitle);
    const topicSlug = slugifyTitle(topicFile.basename);
    await this.app.fileManager.processFrontMatter(hlFile, (fm) => {
      fm.status = 'linked';
      fm.topic_slug = topicSlug;
      fm.topic_path = topicFile.path;
    });
    // Upsert a real body wikilink to the Topic note — "## Topic\n[[Title]]"
    const content = await this.app.vault.read(hlFile);
    const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
    const fmBlock = fmMatch ? fmMatch[0] : '';
    const body = fmMatch ? content.slice(fmMatch[0].length) : content;
    const heading = /^##[ \t]+Topic[ \t]*$/m.exec(body);
    let newBody;
    if (heading) {
      const afterHeading = heading.index + heading[0].length;
      const rest = body.slice(afterHeading);
      const nextHeading = /^##[ \t]+\S/m.exec(rest);
      const contentEnd = nextHeading ? afterHeading + nextHeading.index : body.length;
      newBody = `${body.slice(0, afterHeading)}\n[[${topicFile.basename}]]\n\n${body.slice(contentEnd)}`;
    } else {
      newBody = `## Topic\n\n[[${topicFile.basename}]]\n\n${body}`;
    }
    await this.app.vault.modify(hlFile, fmBlock + newBody);
    this.syncBookForHighlight(hlFile);
    return topicFile;
  }

  // To Read -> Reading once a book is opened in the reader or gets any
  // progress. Any other status (Finished, Abandoned, or Reading set by
  // hand) is left alone. Returns true when it changed the status.
  // setBookStatus (v0.8.0) -- the one path every status change goes
  // through, so `date_finished` (GL-002, added 2026-09-23) stays in step
  // with `status`: stamped with today's LOCAL date the first time a book
  // becomes finished (an existing date is kept, e.g. re-selecting
  // Finished), removed when the book moves off finished so it no longer
  // counts toward the dashboard's "books this year".
  async setBookStatus(file, status) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.status = status;
      if (status === 'finished') {
        if (!fm.date_finished) fm.date_finished = localDayKey(new Date());
      } else if ('date_finished' in fm) {
        delete fm.date_finished;
      }
    });
  }

  async markReadingIfUnstarted(file) {
    const current = this.getFm(file).status;
    if (current && current !== 'to-read') return false;
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (!fm.status || fm.status === 'to-read') { fm.status = 'reading'; changed = true; }
    });
    return changed;
  }

  async setDismissed(hlFile, dismissed) {
    await this.app.fileManager.processFrontMatter(hlFile, (fm) => {
      fm.status = dismissed ? 'dismissed' : 'pending';
    });
    this.syncBookForHighlight(hlFile);
  }

  // unlinkHighlight(hlFile) — sends an already-linked highlight back to
  // pending/unreviewed. Mirror image of linkHighlight() above: resets the
  // same three fields linkHighlight() sets (status, topic_slug, topic_path)
  // rather than inventing a new field (GL-002). A3's Reading Station never
  // actually shipped a true unlink action (its setHighlightDismissed()
  // explicitly refuses to touch a 'linked' highlight, and its deleteHighlight()
  // comment confirms "no existing unlink-only endpoint" existed) — this is
  // new behavior for A4, not a port of working A3 code, but it follows A3's
  // same status/topic_slug data model (status: pending|linked|dismissed).
  // Leaves the body "## Topic\n[[Title]]" section in place (harmless once the
  // frontmatter link is gone) rather than attempting a body-content edit here.
  async unlinkHighlight(hlFile) {
    await this.app.fileManager.processFrontMatter(hlFile, (fm) => {
      fm.status = 'pending';
      fm.topic_slug = null;
      fm.topic_path = null;
    });
    this.syncBookForHighlight(hlFile);
  }

  async updateColor(hlFile, color) {
    await this.app.fileManager.processFrontMatter(hlFile, (fm) => { fm.color = color; });
    this.syncBookForHighlight(hlFile);
  }

  // A per-highlight note, stored on the highlight note's OWN frontmatter
  // (per GL-002's `book_highlight` row) rather than a body section: this
  // note file already keeps every other field (excerpt, color, status) in
  // frontmatter with no body at all, so a body section would be the odd one
  // out, and a frontmatter field lets every place that already lists
  // highlights (the book Detail page, the global Highlights queue) show the
  // note for free from the same getFm() spread they already do, without an
  // extra async vault.read() per highlight just to check "does this one
  // have a note".
  async setHighlightNote(hlFile, text) {
    const clean = String(text || '').trim();
    await this.app.fileManager.processFrontMatter(hlFile, (fm) => { fm.note = clean || null; });
    this.syncBookForHighlight(hlFile);
  }

  // Ask the book (v0.10.0): "Save to book note" adds the question and answer
  // under a "## Questions" heading in the book's own note (John,
  // 2026-09-24). New answers go at the end of that section. A note without
  // one gets it just above the auto-maintained "## Highlights" section,
  // which must stay last (see syncHighlightsSection), or at the very end.
  async saveAnswerToBookNote(bookFile, { question, markdown, model, date }) {
    // An answer's own headings sit under its question (QA fix v0.17.2): a
    // "## " line in an answer used to end the Questions section early.
    const body = String(markdown).trim().replace(/^#{1,3} /gm, '#### ');
    const entry = `### ${String(question).replace(/\s+/g, ' ').trim()}\n\n*${date} · ${model}*\n\n${body}\n`;
    await this.app.vault.process(bookFile, (content) => {
    const qSec = findNoteSection(content, 'Questions');
    let next;
    if (qSec) {
      const end = qSec.end;
      const section = content.slice(0, end).replace(/\s+$/, '');
      const tail = content.slice(end);
      next = `${section}\n\n${entry}${tail ? `\n${tail}` : ''}`;
    } else {
      const hl = /^## Highlights[ \t]*$/m.exec(content);
      if (hl) {
        const before = content.slice(0, hl.index).replace(/\s+$/, '');
        next = `${before}\n\n## Questions\n\n${entry}\n${content.slice(hl.index)}`;
      } else {
        next = `${content.replace(/\s+$/, '')}\n\n## Questions\n\n${entry}`;
      }
    }
    return next;
    });
  }

  // Highlight review (v0.9.0): "Add a thought" adds to the highlight's own
  // note (John, 2026-09-24), after a blank line, never replacing it.
  // Returns the note as saved (null when nothing was added).
  async addHighlightThought(hlFile, text) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    let saved = null;
    await this.app.fileManager.processFrontMatter(hlFile, (fm) => {
      const old = fm.note ? String(fm.note).trim() : '';
      fm.note = old ? `${old}\n\n${clean}` : clean;
      saved = fm.note;
    });
    this.syncBookForHighlight(hlFile);
    return saved;
  }

  // Highlight review (v0.9.0): one answer to "When should this come back?".
  // `days` > 0 schedules the next review that many days after `today`;
  // 0 is "Stop showing this one". See the field notes above
  // REVIEW_PER_DAY_CHOICES. The book note's Highlights section doesn't show
  // any of these, so no re-sync is needed.
  async recordReview(hlFile, days, today) {
    await this.app.fileManager.processFrontMatter(hlFile, (fm) => {
      if (days > 0) {
        fm.review_due = localDayKey(addLocalDays(today, days));
        fm.review_interval = days;
      } else {
        delete fm.review_due;
        fm.review_interval = 0;
      }
      fm.review_count = (Number(fm.review_count) || 0) + 1;
    });
  }

  async deleteHighlight(hlFile) {
    // Capture the owning book BEFORE the delete -- once the file is gone,
    // getFileCache(hlFile) can no longer be trusted to still hold its
    // frontmatter.
    const fm = this.getFm(hlFile);
    const bookFile = fm.book_path ? this.app.vault.getAbstractFileByPath(fm.book_path) : null;
    await this.app.vault.delete(hlFile);
    if (bookFile instanceof TFile) this.scheduleHighlightsSync(bookFile);
  }

  // -------------------- Highlights-in-book-note (v0.4.0) --------------------
  // Single choke point every highlight mutation above calls through
  // (createHighlight, linkHighlight/unlinkHighlight, setDismissed,
  // updateColor, setHighlightNote, deleteHighlight) — covers Reader, Detail,
  // and the triage queue alike since all three already route every write
  // through this store, never touching frontmatter directly themselves.
  syncBookForHighlight(hlFile) {
    const fm = this.getFm(hlFile);
    const bookFile = fm.book_path ? this.app.vault.getAbstractFileByPath(fm.book_path) : null;
    if (bookFile instanceof TFile) this.scheduleHighlightsSync(bookFile);
  }

  // Debounced, per book, coalescing a burst of edits (e.g. several
  // highlights created back to back while reading) into a single write --
  // same v0.2.5 write-throttling spirit as saveProgress()'s no-op guard.
  // 350ms (not the view's own 300ms softRefresh window) so the metadata
  // cache has already caught up with the write that triggered this by the
  // time listHighlights() re-reads it — see the addBookmark/removeBookmark
  // comment above on the exact same cache-lag hazard.
  scheduleHighlightsSync(bookFile) {
    if (!this.plugin || !this.plugin.settings.highlightsInBookNote) return;
    const path = bookFile.path;
    const prev = this._hlSyncTimers.get(path);
    if (prev) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      this._hlSyncTimers.delete(path);
      this.syncHighlightsSection(bookFile).catch((err) => {
        console.error('Reading Vault: Highlights-in-book-note sync failed', err);
      });
    }, 350);
    this._hlSyncTimers.set(path, timer);
  }

  // The actual generator + writer. Returns true if it wrote (used by the
  // backfill pass to count books it actually changed), false on a no-op
  // (setting off, book gone, or the generated block is byte-identical to
  // what's already there).
  async syncHighlightsSection(bookFile) {
    if (!(bookFile instanceof TFile)) return false;
    if (!this.plugin || !this.plugin.settings.highlightsInBookNote) return false;
    const desired = this.buildHighlightsBlockBody(bookFile);
    // Nothing to change means no write at all (a no-op write still counts
    // as a change to sync and to the file's date).
    const pre = await this.app.vault.read(bookFile);
    const already = findNoteSection(pre, 'Highlights');
    if (already && pre.slice(already.start, already.end).trimEnd() === `${HL_SECTION_HEADING}\n\n${desired}`.trimEnd()) return false;
    let wrote = false;
    await this.app.vault.process(bookFile, (content) => {
    // Anchor on a line that is exactly "## Highlights" (not a substring
    // match, so a highlight's own quoted text that happens to contain that
    // phrase can never be mistaken for the heading). The section runs from
    // that heading to the true end of the file -- it is always the LAST
    // thing in the note, by construction: every write below either starts
    // at this exact heading or appends a fresh one after trimming trailing
    // whitespace, so nothing can ever end up after it.
    // QA fix (v0.17.2): the section ends at the next "## " heading, not the
    // end of the note, so anything the reader adds after it is kept.
    const sec = findNoteSection(content, 'Highlights');
    if (sec) {
      const before = content.slice(0, sec.start); // guaranteed untouched, byte-for-byte
      const after = content.slice(sec.end);
      const fresh = `${HL_SECTION_HEADING}\n\n${desired}\n`;
      const current = content.slice(sec.start, sec.end);
      if (current.trimEnd() === fresh.trimEnd()) return content; // unchanged -- never write a no-op
      wrote = true;
      return `${before}${fresh}${after ? `\n${after}` : ''}`;
    }
    // No "## Highlights" heading at all (a note from before this feature,
    // or one where it got hand-deleted) -- never guess where it belongs.
    // Append a fresh block at the very end; everything already in the note
    // (Notes section included) is left byte-for-byte as is.
    const head = content.replace(/\s+$/, '');
    wrote = true;
    return `${head}\n\n${HL_SECTION_HEADING}\n\n${desired}\n`;
    });
    return wrote;
  }

  // The markdown that lives BETWEEN the two markers -- never includes the
  // markers or the heading themselves, so callers can diff it directly
  // against what's already on disk between the same two markers.
  buildHighlightsBlockBody(bookFile) {
    const highlights = this.listHighlights(bookFile.path).filter((h) => h.status !== 'dismissed');
    if (!highlights.length) return '*No highlights yet.*';
    return highlights.map((h) => this.formatHighlightEntry(h)).join('\n\n---\n\n');
  }

  // One highlight's markdown. Colour is shown as a plugin-styled callout
  // whose left bar carries the highlight colour (no title, no icon --
  // CSS in styles.css) so the passage itself stays plain, searchable text
  // with no colour word or emoji glyph in it. EVERY entry uses the callout
  // wrapper, always -- a recognised colour gets its own `a4-hl-<colour>`
  // type; a highlight with no matching colour (the pre-A3-import
  // `color: null` highlights on this vault, or any future unrecognised
  // hex) gets the neutral `a4-hl-none` type instead of falling back to a
  // bare `> "..."` blockquote. Previously that fallback used the SAME
  // markdown structure as a plain quote, which Obsidian (and John's
  // INKLINE theme in particular) renders through a different CSS path
  // than a callout -- an italic handwriting-font blockquote vs. the
  // plain-body-font callout -- so the two kinds of highlight visibly
  // disagreed on font/style even before colour ever entered into it
  // (confirmed 2026-09-23 from John's live screenshot: the two
  // `imported_from: a3` highlights on Essays in Zen Buddhism, both
  // `color: null`, rendered in the theme's handwriting font while the
  // two coloured ones rendered in the plain body font). One wrapper for
  // every entry fixes that at the source, independent of the colour bar
  // itself. `a4-hl-none` deliberately shows no colour bar (styles.css) --
  // the location line already carries the same "no chapter/page when the
  // underlying data doesn't have it" rule (describeHighlightLocationForNote,
  // below), so an entry with no recorded colour simply omits the colour
  // signal too rather than inventing one.
  formatHighlightEntry(h) {
    const colorInfo = HIGHLIGHT_COLORS.find((c) => c.hex === h.color);
    const calloutType = colorInfo ? HL_CALLOUT_TYPE[colorInfo.label] : 'a4-hl-none';
    const quote = String(h.excerpt || '').replace(/\s+/g, ' ').trim();
    const quoteLines = [`> [!${calloutType}]`, `> "${quote}"`];
    const locLabel = describeHighlightLocationForNote(h);
    const hlLink = `obsidian://open-reading-highlight?hl=${encodeUriForMdLink(h.file.path)}`;
    const metaParts = [];
    if (locLabel) metaParts.push(locLabel);
    metaParts.push(`[Open in Reader](${hlLink})`);
    const lines = [...quoteLines, '', metaParts.join(' · ')];
    // A heading line inside a highlight's note would end the generated
    // section early, so it is shown as plain text (QA fix v0.17.2).
    if (h.note) lines.push('', `**Note:** ${String(h.note).trim().replace(/^(#+ )/gm, '\\$1')}`);
    return lines.join('\n');
  }
}

// describeHighlightLocationForNote — same "no live reader session, so no
// real chapter-title lookup" constraint the Detail view's own
// describeBookmarkLocationForDetail() already documents: a plain spine-index
// "Ch. N" for epub (no full EPUB parse just to render a note), or the PDF
// page number.
// encodeURIComponent deliberately leaves ( ) ! ~ * ' unescaped (the old
// RFC2396 "unreserved" set) — harmless almost everywhere, but a highlight
// note's own filename can carry a literal "(1)"-style dedup suffix
// (uniqueVaultPath's own collision handling), and an unescaped ")" inside a
// markdown link's URL segment ends the link early, leaving stray "...).md)"
// text outside it. Escape those few characters on top of encodeURIComponent
// so the "[Open in Reader](url)" link never breaks on a book with more than
// one highlight taken from the exact same moment.
function encodeUriForMdLink(s) {
  return encodeURIComponent(s).replace(/[()!~*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// PDF: page is always known (location_page is set at creation time).
// EPUB: the page-within-chapter is only known for highlights created after
// v0.4.1 started saving it (see the two createHighlight() call sites in
// ReadingView) -- location_cfi's optional ":page:N:of:total" suffix, the
// exact same shape last_cfi/bookmarks already use elsewhere in this file.
// An older highlight whose location_cfi is a bare "spine:N" (saved before
// this fix, or a legacy A3 epubcfi(...) string the Detail page already
// leaves unlabeled today) still renders with chapter only -- page "where
// known", not invented.
function describeHighlightLocationForNote(h) {
  if (h.format === 'pdf') return h.location_page != null ? `p.${h.location_page}` : null;
  const raw = String(h.location_cfi || '');
  const chM = /^spine:(\d+)/.exec(raw);
  if (!chM) return null;
  const chapter = `Ch. ${parseInt(chM[1], 10) + 1}`;
  const pgM = /^spine:\d+:page:(\d+):of:(\d+)/.exec(raw);
  if (pgM && parseInt(pgM[2], 10) > 0) return `${chapter} · p.${parseInt(pgM[1], 10) + 1}`;
  return chapter;
}

function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function escapeYaml(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ---------------------------------------------------------------------------
// Small confirm modal (delete book, etc.)
// ---------------------------------------------------------------------------
class ConfirmModal extends Modal {
  constructor(app, title, message, onConfirm) {
    super(app);
    this.titleText = title; this.message = message; this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('a4r-root');
    const box = contentEl.createDiv({ cls: 'a4r-modal-box' });
    box.createEl('h3', { text: this.titleText });
    box.createDiv({ text: this.message });
    const actions = box.createDiv({ cls: 'a4r-modal-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel', cls: 'a4r-btn-secondary' });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl('button', { text: 'Delete', cls: 'a4r-delete-btn' });
    confirm.onclick = () => { this.close(); this.onConfirm(); };
  }
  onClose() { this.contentEl.empty(); }
}

// "Moved 16 books, 124 highlights and 9 words" -- the Folders (v0.18.0)
// Notice after a move. Only the kinds there were any of.
function folderMoveSummary(kind, counts) {
  const short = { 'book note': ['book', 'books'], 'saved word': ['word', 'words'] };
  const parts = counts.filter(([n]) => n > 0).map(([n, one, many]) => {
    const [o, m] = short[one] || [one, many];
    return `${n} ${n === 1 ? o : m}`;
  });
  if (parts.length <= 1) return parts[0] || 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// Folders (v0.18.0): "Move your books to the new folder?" from the approved
// mockup. Esc or closing the window is the same as "Go back".
class FolderMoveModal extends Modal {
  constructor(app, { kind, from, to, counts, onMove, onBack }) {
    super(app);
    Object.assign(this, { kind, from, to, counts, onMove, onBack });
    this.chosen = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('a4r-root');
    const box = contentEl.createDiv({ cls: 'a4r-modal-box a4r-folder-move' });
    const what = { reading: 'books', topics: 'Topic notes', files: 'book files' }[this.kind];
    const name = { reading: 'Reading folder', topics: 'Topics folder', files: 'folder for book files and covers' }[this.kind];
    box.createEl('h3', { text: `Move your ${what} to the new folder?` });
    const p = box.createEl('p');
    p.appendText(`You changed the ${name} from `);
    p.createEl('b', { text: this.from });
    p.appendText(' to ');
    p.createEl('b', { text: this.to });
    p.appendText('. You already have:');
    const ul = box.createEl('ul');
    for (const [n, one, many] of this.counts) if (n > 0) ul.createEl('li', { text: `${n} ${n === 1 ? one : many}` });
    box.createEl('p', { text: 'Moving them keeps everything together and updates every link to them. Nothing is deleted.' });
    const actions = box.createDiv({ cls: 'a4r-modal-actions' });
    const back = actions.createEl('button', { text: `Go back to ${this.from}`, cls: 'a4r-btn-secondary' });
    back.onclick = () => this.close();
    const move = actions.createEl('button', { text: 'Move them', cls: 'a4r-btn-primary' });
    move.onclick = () => { this.chosen = true; this.close(); this.onMove(); };
  }
  onClose() {
    this.contentEl.empty();
    if (!this.chosen) this.onBack();
  }
}

// Export highlights (v0.11.0): the window from the approved mockup -- choices
// on the left, a live preview of the exact file on the right.
class ExportHighlightsModal extends Modal {
  constructor(app, plugin, bookFile) {
    super(app);
    this.plugin = plugin;
    this.bookFile = bookFile || null;
    this.state = {
      allBooks: !bookFile, fmt: 'md',
      include: { notes: true, where: true, topic: true, bookNotes: false, answers: false },
    };
    this.cache = null; // { books: [...], ready } -- read once per opening
  }

  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('a4r-export-modal');
    contentEl.addClass('a4r-root');
    contentEl.createDiv({ cls: 'a4r-export-loading', text: 'Gathering your highlights…' });
    try {
      this.cache = await this.plugin.gatherExportBooks();
    } catch (err) {
      console.error('Reading Vault: export could not read highlights', err);
      this.cache = [];
    }
    if (!this.containerEl.isConnected) return;
    this.draw();
  }

  onClose() { this.contentEl.empty(); }

  current() {
    const books = this.cache || [];
    const chosen = this.state.allBooks ? books.filter((b) => b.highlights.length) : books.filter((b) => this.bookFile && b.path === this.bookFile.path);
    const now = new Date();
    const text = buildHighlightsExport({
      books: chosen, allBooks: this.state.allBooks, fmt: this.state.fmt, include: this.state.include,
      dateText: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    });
    const title = chosen[0] ? chosen[0].title : (this.bookFile ? this.bookFile.basename : '');
    const name = exportFileName({ allBooks: this.state.allBooks, title, dateKey: localDayKey(now), fmt: this.state.fmt });
    const count = chosen.reduce((n, b) => n + b.highlights.length, 0);
    return { text, name, count, bookCount: chosen.length };
  }

  draw() {
    const { contentEl } = this;
    contentEl.empty();
    const st = this.state;
    const grid = contentEl.createDiv({ cls: 'a4r-export' });
    const left = grid.createDiv({ cls: 'a4r-export-left' });
    const head = left.createDiv();
    head.createEl('h3', { text: 'Export highlights' });
    head.createEl('p', { cls: 'a4r-export-sub', text: 'Makes one file from your highlights. Nothing in your vault changes.' });

    const group = (label) => {
      const fs = left.createEl('fieldset', { cls: 'a4r-export-group' });
      fs.createEl('legend', { cls: 'a4r-export-k', text: label });
      return fs;
    };
    const option = (parent, type, name, checked, label, small, onChange) => {
      const l = parent.createEl('label', { cls: 'a4r-export-opt' });
      const input = l.createEl('input', { type, attr: { name } });
      input.checked = checked;
      const span = l.createSpan({ text: label });
      if (small) span.createEl('small', { text: small });
      input.onchange = () => { onChange(input.checked); this.refresh(); };
      return input;
    };

    const withHl = (this.cache || []).filter((b) => b.highlights.length).length;
    const books = group('Which books');
    if (this.bookFile) {
      const fm = this.plugin.app.metadataCache.getFileCache(this.bookFile);
      const title = (fm && fm.frontmatter && fm.frontmatter.title) || this.bookFile.basename;
      option(books, 'radio', 'a4r-export-scope', !st.allBooks, 'This book', title, (on) => { if (on) st.allBooks = false; });
    }
    option(books, 'radio', 'a4r-export-scope', st.allBooks, 'All books', `${withHl} ${withHl === 1 ? 'book' : 'books'} with highlights`, (on) => { if (on) st.allBooks = true; });

    const inc = group('Include');
    option(inc, 'checkbox', 'notes', st.include.notes, 'My notes on each highlight', null, (on) => { st.include.notes = on; });
    option(inc, 'checkbox', 'where', st.include.where, 'Chapter or page', null, (on) => { st.include.where = on; });
    option(inc, 'checkbox', 'topic', st.include.topic, 'Linked Topic', null, (on) => { st.include.topic = on; });
    option(inc, 'checkbox', 'bookNotes', st.include.bookNotes, 'My notes on the book', 'The "Notes" section of the book\'s note', (on) => { st.include.bookNotes = on; });
    option(inc, 'checkbox', 'answers', st.include.answers, 'Saved answers from Ask', 'The "Questions" section, if there is one', (on) => { st.include.answers = on; });

    const fmt = group('Format');
    option(fmt, 'radio', 'a4r-export-fmt', st.fmt === 'md', 'Markdown (.md)', 'Keeps headings and quotes. Best for Notion, Obsidian and most note apps.', (on) => { if (on) st.fmt = 'md'; });
    option(fmt, 'radio', 'a4r-export-fmt', st.fmt === 'txt', 'Plain text (.txt)', 'Opens anywhere, including email.', (on) => { if (on) st.fmt = 'txt'; });

    this.countEl = left.createDiv({ cls: 'a4r-export-count' });
    const actions = left.createDiv({ cls: 'a4r-export-actions' });
    this.saveBtn = actions.createEl('button', { cls: 'a4r-export-btn is-primary', text: 'Save file…' });
    this.copyBtn = actions.createEl('button', { cls: 'a4r-export-btn', text: 'Copy' });
    const cancel = actions.createEl('button', { cls: 'a4r-export-btn is-quiet', text: 'Cancel' });
    cancel.onclick = () => this.close();
    this.saveBtn.onclick = async () => {
      const cur = this.current();
      if (!cur.count) return;
      this.saveBtn.disabled = true;
      try {
        const where = await this.plugin.saveFileOutsideVault(cur.name, cur.text, this.state.fmt);
        if (where) {
          new Notice(`Saved "${cur.name}".`);
          this.close();
          return;
        }
      } catch (err) {
        console.error('Reading Vault: export save failed', err);
        new Notice("Couldn't save the file. Details are in the developer console.");
      }
      this.saveBtn.disabled = false;
    };
    this.copyBtn.onclick = async () => {
      const cur = this.current();
      if (!cur.count) return;
      try {
        await navigator.clipboard.writeText(cur.text);
        new Notice('Copied to the clipboard.');
      } catch { new Notice("Couldn't copy to the clipboard."); }
    };
    // Exporting is Pro (v0.16.0, built to the approved mockup-pro-locks.html).
    // The window still opens with its preview; Save and Copy don't.
    if (!this.plugin.isPro()) {
      for (const b of [this.saveBtn, this.copyBtn]) {
        b.createSpan({ cls: 'a4r-dash-pro a4r-pro-on-btn', text: 'Pro' });
        b.onclick = () => {};
      }
      const note = left.createDiv({ cls: 'a4r-export-pro-note' });
      note.createEl('b', { text: 'Exporting comes with Pro.' });
      note.appendText(' Your highlights are always in your vault as regular notes, whatever your plan.');
    }

    const right = grid.createDiv({ cls: 'a4r-export-right' });
    const ph = right.createDiv({ cls: 'a4r-export-phead' });
    ph.createSpan({ cls: 'a4r-export-k', text: 'Preview' });
    this.nameEl = ph.createSpan({ cls: 'a4r-export-fname' });
    this.previewEl = right.createEl('pre', { cls: 'a4r-export-preview' });
    this.refresh();
  }

  refresh() {
    const cur = this.current();
    this.previewEl.setText(cur.count ? cur.text : 'No highlights to export yet. Highlights you make in the Reader show up here.');
    this.nameEl.setText(cur.name);
    this.countEl.setText(cur.count
      ? `${cur.count} ${cur.count === 1 ? 'highlight' : 'highlights'} from ${cur.bookCount} ${cur.bookCount === 1 ? 'book' : 'books'}${this.state.include.notes ? ', with your notes' : ''}`
      : 'Nothing to export yet');
    this.saveBtn.disabled = !cur.count;
    this.copyBtn.disabled = !cur.count;
  }
}

// ---------------------------------------------------------------------------
// ReadingView — one ItemView driving all four screens.
// ---------------------------------------------------------------------------
class ReadingView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = new ReadingStore(this.app, plugin);
    this.screen = 'grid';
    this.currentBook = null;
    this.gridFilter = { search: '', status: 'all', format: 'all', author: 'all', shelf: null }; // shelf: v0.12.0, null = All books
    this.editingNotes = false;
    this.reader = null; // built fresh each time we enter the reader
    this.pendingBookmarkJump = null; // set by openBookmarkFromDetail(), consumed once by the next renderReader()
    this.hlSelectedTopic = null;
    this.hlSearchText = '';
    this.hlPopupClose = null; // closes the open highlight color popup, if any
    this.hlActiveHighlightPath = null; // which pending highlight is shown in the global Highlights queue's right-hand panel
    this.review = null; // today's highlight-review session (v0.9.0), see renderReview()
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Reading Vault'; }
  getIcon() { return 'book-open'; }

  async onOpen() {
    await this.store.ensureFolders();
    // "Auto" page colour follows Obsidian's light/dark switch (which follows
    // the computer's when Obsidian is set to adapt to the system) live.
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyAutoPageColour()));
    // Only react to changes inside Reading's own folders (a book, a
    // highlight, or a Topic note being edited elsewhere) — a global vault
    // 'modify' listener with no path filter would re-render on every
    // unrelated file save in the vault, discarding whatever the user was
    // mid-typing in a search box or the notes editor.
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file.path.startsWith(`${READING_DIR}/`) || file.path.startsWith(`${TOPICS_DIR}/`)) this.softRefresh();
    }));
    // A note Obsidian has just finished reading (a newly added book's cover
    // and author, say): redraw once it can be shown in full (QA fix v0.17.3).
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (file && (file.path.startsWith(`${READING_DIR}/`) || file.path.startsWith(`${TOPICS_DIR}/`))) this.softRefresh();
    }));
    // The open book's note deleted elsewhere in Obsidian (QA fix v0.17.3):
    // leave its page for the Library instead of showing a broken page whose
    // buttons do nothing. currentBook is cleared first so nothing is saved
    // back to the deleted note on the way out.
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.currentBook && file && file.path === this.currentBook.path) {
        this.currentBook = null;
        if (this.reader) this.reader.dirty = false;
        if (this.screen === 'reader' || this.screen === 'detail') this.goto('grid');
        return;
      }
      if (file && (file.path.startsWith(`${READING_DIR}/`) || file.path.startsWith(`${TOPICS_DIR}/`))) this.softRefresh();
    }));
    // On a fresh Obsidian launch the metadata cache (frontmatter parsing)
    // can still be catching up when this view first renders — book notes
    // would briefly read back with no cover_path/author/etc, showing the
    // no-cover placeholder even though the note's frontmatter is correct.
    // Re-render once when Obsidian signals the initial cache pass is done.
    const onResolved = () => {
      this.app.metadataCache.off('resolved', onResolved);
      this.softRefresh();
    };
    this.app.metadataCache.on('resolved', onResolved);
    this.register(() => this.app.metadataCache.off('resolved', onResolved));
    // Left/right arrow keys page through the reader, same as the on-screen
    // nav buttons (whose disabled/onclick state already encodes whether a
    // page turn is even possible right now) -- skipped while typing in any
    // real input so it doesn't hijack normal text editing/searching.
    this.registerDomEvent(document, 'keydown', (evt) => {
      if (this.screen !== 'reader' || !this.reader) return;
      // QA fix (v0.17.2): only while this Reading tab is the one in use, with
      // no window (Settings, a dialog) open over it, and never with Cmd,
      // Ctrl or Option held -- those belong to Obsidian and the Mac.
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
      const active = this.app.workspace.activeLeaf;
      if (active && active !== this.leaf) return;
      if (document.querySelector('.modal-container, .modal')) return;
      const t = evt.target;
      const inInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') {
        if (inInput) return;
        const btn = evt.key === 'ArrowRight' ? this.reader.nextBtn : this.reader.prevBtn;
        if (btn && !btn.disabled) { evt.preventDefault(); btn.click(); }
        return;
      }
      // Listen feature — Space toggles play/pause, H saves the sentence
      // being read as a highlight. Both only make sense once a chapter's
      // sentences are loaded (this.reader.tts is built by
      // rebuildTtsSentences the first time an epub chapter renders).
      if (!this.reader.tts) return;
      if (inInput) return;
      if (evt.code === 'Space' || evt.key === ' ') {
        evt.preventDefault();
        this.onPlayButtonClick(this.containerEl.querySelector('.a4r-app'));
      } else if (evt.key === 'h' || evt.key === 'H') {
        evt.preventDefault();
        this.saveCurrentSentenceAsHighlight(this.containerEl.querySelector('.a4r-app'));
      }
    });
    // Voice list loads asynchronously in Electron/Chromium — refresh the
    // Listen bar's voice chip once the real list is ready instead of being
    // stuck on "Voice" the whole session.
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => this.updateListenBarUI();
    }
    this.render();
  }

  async onClose() {
    this.exitFullScreen({ rerender: false });
    this.stopPlayback();
    this.flushProgress();
    this.plugin.sessionRecorder.endCurrent(); // closing the Reader always ends a running session
    if (this.reader && this.reader.epub && this.reader.epub.resizeObserver) {
      this.reader.epub.resizeObserver.disconnect();
      this.reader.epub.resizeObserver = null;
    }
    this.releasePdf(this.reader);
    this.dismissHighlightPopup({ quiet: true });
  }

  softRefresh() {
    // Never blow away an in-progress edit (notes textarea, tag/search
    // inputs) or a live reading session.
    if (this.editingNotes || this.editingSummary || this.screen === 'reader') return;
    if (this.screen === 'grid' || this.screen === 'detail' || this.screen === 'highlights') {
      // metadataCache updates asynchronously after a vault modify — give it
      // a tick before re-reading frontmatter.
      // One trailing timer, not one per event: a burst of saves inside the
      // Reading folders used to queue a separate 50ms render each. 300ms
      // coalesces the burst into a single redraw and still leaves the
      // metadata cache a beat to catch up before re-reading frontmatter.
      if (this._softRefreshTimer) window.clearTimeout(this._softRefreshTimer);
      this._softRefreshTimer = window.setTimeout(() => {
        this._softRefreshTimer = null;
        // ...nor a shelf name being typed (v0.12.0).
        if (!this.editingNotes && !this.editingSummary && !this.creatingShelf && !this.renamingShelf && !this.newShelfForDetail) this.render();
      }, 300);
    }
  }

  goto(screen) {
    if (this.screen === 'review' && screen !== 'review') {
      this.flushReviewThought().catch((err) => console.error('Reading Vault: could not save a thought', err));
    }
    if (screen !== 'reader') {
      this.stopPlayback();
      this.flushProgress();
      this.plugin.sessionRecorder.endCurrent(); // leaving the Reader always ends a running session
      // "Back to p. N" (v0.5.0) does not survive leaving the Reader --
      // Detail's "Continue Reading" and reopening from Grid already resolve
      // to the real saved position, so there's nothing left to go "back" to.
      if (this.reader) this.reader.backToPos = null;
    }
    if (this.fullScreen && screen !== 'reader') this.exitFullScreen({ rerender: false });
    this.screen = screen;
    this.editingNotes = false;
    this.editingSummary = false; // book summary (v0.14.0)
    this.summaryExpanded = false;
    this.creatingShelf = false; // shelf name boxes (v0.12.0) never outlive the screen
    this.renamingShelf = null;
    this.newShelfForDetail = false;
    this.hlSelectedTopic = null;
    this.hlSearchText = '';
    this.hlActiveHighlightPath = null;
    this.render();
  }

  openBook(file, screen = 'detail') {
    this.stopPlayback();
    this.flushProgress();
    this.plugin.sessionRecorder.endCurrent(); // a book change always ends a running session
    if (this.reader && this.reader.epub && this.reader.epub.resizeObserver) this.reader.epub.resizeObserver.disconnect();
    this.releasePdf(this.reader);
    this.currentBook = file;
    this.reader = null;
    // A new book's listen_pos values (e.g. "spine:0:sent:0") can collide
    // textually with the previous book's -- reset the throttle's "last
    // written" memory so the new book's first save isn't wrongly skipped.
    this._lastSavedListenPos = null;
    this._lastListenSaveAt = 0;
    this.goto(screen);
  }

  // { path, title } for the book currently open in the Reader -- the shape
  // SessionRecorder.noteActivity() keys a session on. null when no book is
  // open (callers must skip logging in that case).
  bookInfo() {
    if (!this.currentBook) return null;
    const fm = this.store.getFm(this.currentBook) || {};
    return { path: this.currentBook.path, title: fm.title || this.currentBook.basename };
  }

  flushProgress() {
    if (this.reader && this.reader.dirty) {
      this.reader.dirty = false;
      if (this.reader.saveTimer) { window.clearTimeout(this.reader.saveTimer); this.reader.saveTimer = null; }
      this.persistProgressNow();
    }
  }

  async persistProgressNow() {
    if (!this.reader || !this.currentBook) return;
    const r = this.reader;
    const fields = { last_page: null, last_cfi: null, progress_percent: null };
    if (r.format === 'pdf') {
      fields.last_page = r.pdf.page;
      fields.progress_percent = r.pdf.pageCount ? (r.pdf.page / r.pdf.pageCount) * 100 : null;
    } else {
      const total = r.epub.pageCountInChapter || 1;
      fields.last_cfi = `spine:${r.epub.idx}:page:${r.epub.page || 0}:of:${total}`;
      fields.progress_percent = r.epub.spine.length
        ? computeEpubProgressPercent(r.epub.spine, r.epub.entries, r.epub.idx, total, r.epub.page || 0)
        : null;
    }
    await this.store.saveProgress(this.currentBook, fields);
    if (fields.progress_percent > 0) this.markBookStarted(this.currentBook);
  }

  // Opening a book / making progress moves it from To Read to Reading. The
  // reader screen skips soft refreshes, so update its status pill in place.
  markBookStarted(file) {
    this.store.markReadingIfUnstarted(file).then((changed) => {
      if (!changed) return;
      this.containerEl.querySelectorAll('.a4r-status-pill-top').forEach((el) => el.setText(STATUS_LABELS.reading));
    }).catch((err) => console.error('Reading Vault: could not set status to Reading', err));
  }

  scheduleProgressSave() {
    if (!this.reader) return;
    // "Reading on" (page turn, Listen advancing) from wherever a jump landed
    // is a real decision to keep reading here -- this spot becomes the new
    // saved position (persistProgressNow(), scheduled below, does that), so
    // there's nothing left to go "back" to. Every real-progress call site
    // funnels through this one function, so clearing the chip here (rather
    // than at each call site) can't drift out of sync. See the "Back to p.
    // N" chip notes (v0.5.0) on beginJump()/resolvePendingBackToPos().
    this.reader.backToPos = null;
    this.reader._pendingBackToPos = null;
    this.reader.dirty = true;
    if (this.reader.saveTimer) window.clearTimeout(this.reader.saveTimer);
    this.reader.saveTimer = window.setTimeout(() => {
      this.reader.dirty = false;
      this.persistProgressNow();
    }, 1500);
  }

  // -------------------- "Back to p. N" chip (v0.5.0) --------------------
  // A navigation jump (highlight, bookmark, search result, Contents entry)
  // is a "take me here" click, never "I kept reading" -- it must never
  // overwrite the saved reading position (v0.4.5), but the reader still
  // needs a visible, one-tap way back to the spot the jump moved away from.
  //
  // beginJump(r, file) is called at the START of every jump, before any
  // r.epub/r.pdf mutation. It reads the book note's own on-disk
  // last_page/last_cfi -- not the reader's live in-memory position -- as
  // the thing to point back to: since a jump never calls
  // scheduleProgressSave() (v0.4.5), that frontmatter is guaranteed to
  // still be the real saved position no matter how many renders or async
  // steps the jump itself takes. If a chip is already showing, beginJump()
  // deliberately does nothing, so a second jump keeps pointing at the
  // ORIGINAL saved position, per the approved mockup.
  //
  // resolvePendingBackToPos(r) is called once, from the one settled point
  // in each of renderEpubPage()/renderPdfPage() where a render's landing
  // page is truly final for that pass (after any pendingPageFraction/
  // pendingTextExcerpt precision refinement) -- covers every jump path,
  // sync or async, live-in-Reader or opened fresh from a book note's "Open
  // in Reader" link, without each jump function needing its own end-of-jump
  // bookkeeping. A landing spot that turns out identical to the saved
  // position (e.g. a bookmark on the page already being read) shows no chip.
  snapshotSavedPosition(r, fm) {
    if (r.format === 'pdf') {
      const p = typeof fm.last_page === 'number' ? fm.last_page : 1;
      return { format: 'pdf', page: p, label: `p.${p}` };
    }
    const m = typeof fm.last_cfi === 'string' ? /^spine:(\d+)(?::page:(\d+):of:(\d+))?$/.exec(fm.last_cfi) : null;
    const idx = m ? parseInt(m[1], 10) : 0;
    const page = m && m[2] !== undefined ? parseInt(m[2], 10) : 0;
    return { format: 'epub', idx, page, label: `p.${page + 1}` };
  }

  landedPosition(r) {
    if (r.format === 'pdf') return { page: r.pdf.page };
    return { idx: r.epub.idx, page: r.epub.page };
  }

  positionsEqual(r, saved, landed) {
    if (r.format === 'pdf') return saved.page === landed.page;
    return saved.idx === landed.idx && saved.page === landed.page;
  }

  beginJump(r, file) {
    if (r.backToPos) return; // chip already up -- keep pointing at the original target
    r._pendingBackToPos = this.snapshotSavedPosition(r, this.store.getFm(file));
  }

  resolvePendingBackToPos(r) {
    const snap = r._pendingBackToPos;
    if (!snap) return;
    r._pendingBackToPos = null;
    if (!this.positionsEqual(r, snap, this.landedPosition(r))) r.backToPos = snap;
  }

  // Tapping the chip itself: return to the saved position it names, and
  // clear it -- reader and saved position are back in lock-step, so there's
  // nothing left to show.
  returnToBackToPos(r, appEl) {
    const snap = r.backToPos;
    if (!snap) return;
    r.uiPanel = null;
    if (snap.format === 'pdf') {
      this.pdfStopListenOnHandTurn();
      r.pdf.page = snap.page;
    } else {
      this.epubStopListenOnJump(r);
      r.epub.idx = snap.idx;
      r.epub.page = snap.page;
    }
    r.backToPos = null;
    this.renderReader(appEl);
  }

  // ---------------- render dispatch ----------------
  render() {
    this.dismissHighlightPopup({ quiet: true });
    // A full redraw replaces the element that is full screen; leave it
    // cleanly first rather than lose it.
    if (this.fullScreen) this.exitFullScreen({ rerender: false });
    const container = this.containerEl.children[1];
    container.empty();
    const root = container.createDiv({ cls: 'a4r-root' });
    const appEl = root.createDiv({ cls: 'a4r-app' });
    this.renderChrome(appEl);
    this.renderTabs(appEl);

    if (this.screen === 'reader') {
      this.renderReader(appEl);
      return;
    }
    const body = appEl.createDiv({ cls: 'a4r-screen-body' });
    if (this.screen === 'grid') this.renderGrid(body);
    else if (this.screen === 'detail') this.renderDetail(body);
    else if (this.screen === 'highlights') this.renderHighlights(body);
    else if (this.screen === 'review') this.renderReview(body);
  }

  renderChrome(appEl) {
    const top = appEl.createDiv({ cls: 'a4r-app-top' });
    const back = top.createEl('button', { cls: 'a4r-back-link' });
    if (this.screen === 'grid') {
      back.setText('← All libraries');
      back.onclick = () => this.leaf.detach();
    } else if (this.screen === 'detail' || this.screen === 'review' || !this.currentBook) {
      back.setText('← Back to Reading');
      back.onclick = () => this.goto('grid');
    } else {
      const fm = this.store.getFm(this.currentBook);
      back.setText(`← Back to ${fm.title || this.currentBook.basename}`);
      back.onclick = () => this.goto('detail');
    }
    const right = top.createDiv({ cls: 'a4r-top-right' });
    if (this.currentBook && (this.screen === 'detail' || this.screen === 'reader' || this.screen === 'highlights')) {
      const fm = this.store.getFm(this.currentBook);
      right.createDiv({ cls: 'a4r-status-pill-top', text: STATUS_LABELS[fm.status] || 'To Read' });
    }
    const gear = right.createDiv({ cls: 'a4r-gear', text: '⚙' });
    gear.onclick = (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('Rescan library').setIcon('refresh-cw').onClick(() => this.render()));
      menu.addItem((i) => i.setTitle('About Reading Vault').setIcon('info').onClick(() => {
        new Notice(`Reading Vault ${this.plugin.manifest ? `v${this.plugin.manifest.version}` : ''}. Books, highlights, and progress are stored as notes in "${READING_DIR}/". You can change the folders in Settings.`);
      }));
      menu.showAtMouseEvent(e);
    };
  }

  renderTabs(appEl) {
    const row = appEl.createDiv({ cls: 'a4r-tab-row' });
    // Highlights is NEVER disabled, matching A3's real tab logic: with a
    // book open it goes to the book-scoped triage queue; with no book open
    // (straight from Grid) it goes to the library-wide "All Highlights"
    // queue (renderHighlightsGlobal). Only Detail/Reader still require a
    // book open and stay disabled without one.
    const tabs = [
      ['grid', 'Grid', true],
      ['detail', 'Detail', !!this.currentBook],
      ['reader', 'Reader', !!this.currentBook],
      ['highlights', 'Highlights', true],
    ];
    for (const [key, label, enabled] of tabs) {
      const t = row.createEl('button', {
        cls: `a4r-tab${this.screen === key ? ' a4r-active' : ''}${enabled ? '' : ' a4r-tab-disabled'}`,
        text: label,
      });
      // Intentionally NOT using the native `disabled` attribute here: a
      // disabled button eats the click entirely (no event fires), which is
      // indistinguishable from the plugin being broken. Keep it clickable
      // and no-op quietly instead of a silent-looking dead button.
      t.onclick = () => {
        if (!enabled) return;
        this.goto(key);
      };
    }
  }

  // ==================== GRID ====================
  renderGrid(body) {
    const books = this.store.listBooks();

    const head = body.createDiv({ cls: 'a4r-grid-head' });
    const titleWrap = head.createDiv({ cls: 'a4r-grid-title' });
    titleWrap.createDiv({ cls: 'a4r-icon', text: '📖' });
    titleWrap.createEl('h2', { text: 'Reading' });
    const addBtn = head.createEl('button', { cls: 'a4r-add-btn', text: '+ Add Books' });

    const fileInput = body.createEl('input', { type: 'file', attr: { accept: '.pdf,.epub', multiple: true } });
    fileInput.style.display = 'none';
    fileInput.onchange = () => { this.handleFiles(fileInput.files); fileInput.value = ''; };
    addBtn.onclick = () => fileInput.click();

    const inProgress = books.filter((b) => b.status === 'reading').length;
    body.createDiv({ cls: 'a4r-grid-stats', text: `${books.length} book${books.length === 1 ? '' : 's'} · ${inProgress} in progress` });
    this.buildTodayStrip(body);

    const dropZone = body.createDiv({ cls: 'a4r-drop-zone' });
    dropZone.setText('Drag a PDF or EPUB here, or ');
    const browseLink = dropZone.createEl('a', { text: 'browse files' });
    browseLink.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.addClass('a4r-drag-over'); };
    dropZone.ondragleave = () => dropZone.removeClass('a4r-drag-over');
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.removeClass('a4r-drag-over');
      if (e.dataTransfer && e.dataTransfer.files.length) this.handleFiles(e.dataTransfer.files);
    };

    const searchRow = body.createDiv({ cls: 'a4r-search-row' });
    const searchBox = searchRow.createDiv({ cls: 'a4r-search-box' });
    searchBox.createSpan({ text: '🔍' });
    const searchInput = searchBox.createEl('input', { attr: { placeholder: 'Search title or author…' }, value: this.gridFilter.search });
    searchInput.oninput = () => { this.gridFilter.search = searchInput.value; this.rerenderGridBooksOnly(body, statusSel, formatSel, authorsCol, gridEl, statsEl); };

    const statusBox = searchRow.createDiv({ cls: 'a4r-select-box' });
    statusBox.createEl('label', { text: 'STATUS' });
    const statusSel = statusBox.createEl('select');
    statusSel.createEl('option', { text: 'All', value: 'all' });
    for (const s of VALID_STATUSES) statusSel.createEl('option', { text: STATUS_LABELS[s], value: s });
    statusSel.value = this.gridFilter.status;
    statusSel.onchange = () => { this.gridFilter.status = statusSel.value; this.rerenderGridBooksOnly(body, statusSel, formatSel, authorsCol, gridEl, statsEl); };

    const formatBox = searchRow.createDiv({ cls: 'a4r-select-box' });
    formatBox.createEl('label', { text: 'FORMAT' });
    const formatSel = formatBox.createEl('select');
    formatSel.createEl('option', { text: 'All', value: 'all' });
    formatSel.createEl('option', { text: 'PDF', value: 'pdf' });
    formatSel.createEl('option', { text: 'EPUB', value: 'epub' });
    formatSel.value = this.gridFilter.format;
    formatSel.onchange = () => { this.gridFilter.format = formatSel.value; this.rerenderGridBooksOnly(body, statusSel, formatSel, authorsCol, gridEl, statsEl); };

    const libLayout = body.createDiv({ cls: 'a4r-lib-layout' });
    const authorsCol = libLayout.createDiv();
    const gridEl = libLayout.createDiv({ cls: 'a4r-book-grid' });
    const statsEl = null;
    this.renderGridBooks(books, authorsCol, gridEl);
  }

  // buildTodayStrip (v0.8.0) -- the one quiet summary line at the top of
  // the Library from the approved dashboard mockup ("What free users see
  // instead"). Same numbers as the dashboard's Today section. While
  // DASHBOARD_PRO_UNLOCKED is on, its right side is the Library's way into
  // the dashboard; when off, it shows the mockup's "in Pro" line instead.
  buildTodayStrip(body) {
    const t = this.plugin.readingSummary(new Date());
    const strip = body.createDiv({ cls: 'a4r-free-strip' });
    const line = strip.createDiv({ cls: 'a4r-free-line' });
    line.createEl('b', { text: 'Today' });
    line.createSpan({ text: `${Math.round(t.todayMinutes)} min` });
    line.createSpan({ cls: 'a4r-free-sep', text: '|' });
    line.createSpan({ text: `${t.todayPages} ${t.todayPages === 1 ? 'page' : 'pages'}` });
    line.createSpan({ cls: 'a4r-free-sep', text: '|' });
    line.createSpan({ text: `${t.streak.cur}-day streak` });
    // Highlight review (v0.9.0): only shown when something is ready.
    if (this.plugin.isPro()) {
      const ready = this.plugin.reviewSummary(new Date()).ready;
      if (ready) {
        line.createSpan({ cls: 'a4r-free-sep', text: '|' });
        const rv = line.createEl('button', { cls: 'a4r-free-review', text: `Review ${ready} ${ready === 1 ? 'highlight' : 'highlights'} →` });
        rv.onclick = () => this.startReview();
      }
    }
    const right = this.plugin.isPro()
      ? strip.createEl('button', { cls: 'a4r-free-open' })
      : strip.createDiv({ cls: 'a4r-free-locked' });
    const mini = right.createSpan({ cls: 'a4r-free-mini', attr: { 'aria-hidden': 'true' } });
    [[6, 9], [17, 15], [28, 11], [39, 19], [50, 13], [61, 21], [72, 8]].forEach(([left, h]) => {
      const i = mini.createEl('i'); i.style.left = `${left}px`; i.style.height = `${h}px`;
    });
    if (this.plugin.isPro()) {
      right.createSpan({ text: 'Reading Dashboard →' });
      setTooltip(right, 'Open the Reading Dashboard');
      right.onclick = () => this.plugin.activateDashboard();
    } else {
      right.createSpan({ text: 'Charts, goals and your reading calendar are in Pro' });
    }
  }

  rerenderGridBooksOnly(body, statusSel, formatSel, authorsCol, gridEl) {
    const books = this.store.listBooks();
    this.renderGridBooks(books, authorsCol, gridEl);
  }

  renderGridBooks(allBooks, authorsCol, gridEl) {
    authorsCol.empty();
    gridEl.empty();
    const rerender = () => this.renderGridBooks(this.store.listBooks(), authorsCol, gridEl);
    this.renderShelvesList(authorsCol, allBooks, rerender);

    const authorCounts = new Map();
    for (const b of allBooks) {
      const a = (b.author || 'Unknown').trim() || 'Unknown';
      authorCounts.set(a, (authorCounts.get(a) || 0) + 1);
    }
    authorsCol.createDiv({ cls: 'a4r-authors-h', text: '👤 AUTHORS' });
    const allRow = authorsCol.createEl('button', { cls: `a4r-author-row${this.gridFilter.author === 'all' ? ' a4r-active' : ''}` });
    allRow.createSpan({ text: 'All authors' });
    allRow.createSpan({ cls: 'a4r-count', text: String(allBooks.length) });
    allRow.onclick = () => { this.gridFilter.author = 'all'; this.renderGridBooks(allBooks, authorsCol, gridEl); };
    for (const [author, count] of [...authorCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const row = authorsCol.createEl('button', { cls: `a4r-author-row${this.gridFilter.author === author ? ' a4r-active' : ''}` });
      // Long names end in "…" with the full name on hover (v0.12.2, from
      // John's screenshot), so the count bubble always stays whole.
      row.createSpan({ cls: 'a4r-author-name', text: author });
      setTooltip(row, author);
      row.createSpan({ cls: 'a4r-count', text: String(count) });
      row.onclick = () => { this.gridFilter.author = author; this.renderGridBooks(allBooks, authorsCol, gridEl); };
    }

    const q = this.gridFilter.search.trim().toLowerCase();
    const filtered = allBooks.filter((b) => {
      if (this.gridFilter.status !== 'all' && b.status !== this.gridFilter.status) return false;
      if (this.gridFilter.format !== 'all' && b.format !== this.gridFilter.format) return false;
      if (this.gridFilter.author !== 'all' && (b.author.trim() || 'Unknown') !== this.gridFilter.author) return false;
      if (q && !`${b.title || ''} ${b.author || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });

    // Shelves (v0.12.0): a chosen shelf narrows the grid to its books, in
    // the shelf's own order; the heading names it and carries its ⋯ menu.
    const shelf = this.gridFilter.shelf ? this.store.findShelf(this.gridFilter.shelf) : null;
    if (this.gridFilter.shelf && !shelf) this.gridFilter.shelf = null; // renamed or deleted elsewhere
    let shown = filtered;
    if (shelf) {
      const onShelf = new Set(this.store.booksOnShelf(shelf.name).map((b) => b.file.path));
      shown = sortByShelfOrder(filtered.filter((b) => onShelf.has(b.file.path)), shelf.order);
    }
    this.renderShelfHeading(gridEl, shelf, shown.length, rerender);

    if (!shown.length) {
      gridEl.createDiv({
        cls: 'a4r-empty-state',
        text: shelf && !this.store.booksOnShelf(shelf.name).length
          ? 'No books on this shelf yet. Go to All books and drag a cover onto this shelf, or add it from a book\'s page.'
          : 'No books match. Try clearing a filter, or add your first book above.',
      });
      return;
    }

    for (const b of shown) {
      const card = gridEl.createEl('button', { cls: 'a4r-book-card' });
      this.makeBookCardDraggable(card, b, shelf, shown, rerender);
      const cover = card.createDiv({ cls: 'a4r-cover' });
      const statusPill = cover.createDiv({ cls: `a4r-status${b.status === 'reading' ? ' a4r-reading' : ''}`, text: (STATUS_LABELS[b.status] || 'To Read').toUpperCase() });
      const coverFile = b.cover_path ? this.app.vault.getAbstractFileByPath(b.cover_path) : null;
      if (coverFile) {
        const img = cover.createEl('img');
        img.src = this.app.vault.adapter.getResourcePath(b.cover_path);
      } else {
        const [bg, fg] = pickPlaceholderColor(b.title || '');
        cover.style.background = bg;
        cover.style.color = fg;
        cover.createSpan({ cls: 'a4r-cover-fallback-text', text: b.title || 'Untitled' });
      }
      card.createDiv({ cls: 'a4r-book-title', text: b.title || b.file.basename });
      card.createDiv({ cls: 'a4r-book-author', text: b.author || '' });
      card.onclick = () => this.openBook(b.file, 'detail');
    }
  }

  // ==================== SHELVES (v0.12.0) ====================
  // Built to the approved mockup-shelves.html: a Shelves list above Authors
  // in the Library's left column, drag a cover onto a shelf to add it, drag
  // covers within a shelf to reorder, ⋯ on a shelf to rename or delete it.
  renderShelvesList(col, allBooks, rerender) {
    const head = col.createDiv({ cls: 'a4r-authors-h a4r-shelves-h' });
    head.createSpan({ text: '📚 SHELVES' });
    const add = head.createEl('button', { cls: 'a4r-shelf-new', text: '+ New' });
    setTooltip(add, 'Make a new shelf');
    add.onclick = () => { this.creatingShelf = true; rerender(); };

    const rows = col.createDiv({ cls: 'a4r-shelf-rows' });
    const allRow = rows.createEl('button', { cls: `a4r-author-row${!this.gridFilter.shelf ? ' a4r-active' : ''}` });
    allRow.createSpan({ text: 'All books' });
    allRow.createSpan({ cls: 'a4r-count', text: String(allBooks.length) });
    allRow.onclick = () => { this.gridFilter.shelf = null; rerender(); };

    for (const shelf of this.store.listShelves()) {
      const count = this.store.booksOnShelf(shelf.name).length;
      if (this.renamingShelf && this.renamingShelf.toLowerCase() === shelf.name.toLowerCase()) {
        this.shelfNameInput(rows, shelf.name, async (value) => {
          const ok = await this.store.renameShelf(shelf.name, value);
          if (!ok && cleanShelfName(value) && cleanShelfName(value).toLowerCase() !== shelf.name.toLowerCase()) {
            new Notice('There is already a shelf with that name.');
            return false;
          }
          if (ok && this.gridFilter.shelf && this.gridFilter.shelf.toLowerCase() === shelf.name.toLowerCase()) this.gridFilter.shelf = cleanShelfName(value);
          this.renamingShelf = null;
          rerender();
          return true;
        }, () => { this.renamingShelf = null; rerender(); });
        continue;
      }
      const active = this.gridFilter.shelf && this.gridFilter.shelf.toLowerCase() === shelf.name.toLowerCase();
      const row = rows.createEl('button', { cls: `a4r-author-row a4r-shelf-row${active ? ' a4r-active' : ''}` });
      row.dataset.shelf = shelf.name;
      row.createSpan({ cls: 'a4r-shelf-name', text: shelf.name });
      row.createSpan({ cls: 'a4r-count', text: String(count) });
      row.onclick = () => { this.gridFilter.shelf = shelf.name; rerender(); };
      // Drop a dragged cover here to put that book on this shelf.
      row.ondragover = (e) => { if (!this.dragBookPath) return; e.preventDefault(); row.addClass('a4r-drop'); };
      row.ondragleave = () => row.removeClass('a4r-drop');
      row.ondrop = async (e) => {
        e.preventDefault();
        row.removeClass('a4r-drop');
        const path = this.dragBookPath;
        this.dragBookPath = null;
        const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
        if (!(file instanceof TFile)) return;
        const already = this.store.booksOnShelf(shelf.name).some((x) => x.file.path === file.path);
        await this.store.addBookToShelf(file, shelf.name);
        const fm = this.store.getFm(file);
        new Notice(already ? `"${fmText(fm.title) || file.basename}" is already on ${shelf.name}.` : `Added "${fmText(fm.title) || file.basename}" to ${shelf.name}.`);
        rerender();
      };
    }

    if (this.creatingShelf) {
      this.shelfNameInput(rows, '', async (value) => {
        const name = await this.store.createShelf(value);
        if (!name) {
          if (cleanShelfName(value)) { new Notice('There is already a shelf with that name.'); return false; }
          this.creatingShelf = false;
          rerender();
          return true;
        }
        this.creatingShelf = false;
        this.gridFilter.shelf = name;
        rerender();
        return true;
      }, () => { this.creatingShelf = false; rerender(); });
    }
    col.createDiv({ cls: 'a4r-shelf-hint', text: 'Drag a book onto a shelf to add it.' });
  }

  // One inline name box (new shelf, or renaming one). Enter or Add saves;
  // Escape cancels. onSave returns false to keep the box open.
  shelfNameInput(parent, value, onSave, onCancel) {
    const box = parent.createDiv({ cls: 'a4r-shelf-input' });
    const input = box.createEl('input', { attr: { placeholder: 'Shelf name', 'aria-label': 'Shelf name', maxlength: String(SHELF_NAME_MAX) } });
    input.value = value;
    const ok = box.createEl('button', { text: value ? 'Save' : 'Add' });
    let busy = false;
    const save = async () => {
      if (busy) return;
      busy = true;
      const done = await onSave(input.value);
      busy = false;
      if (done === false) input.focus();
    };
    ok.onclick = save;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  renderShelfHeading(gridEl, shelf, count, rerender) {
    const head = gridEl.createDiv({ cls: 'a4r-shelf-head' });
    const text = head.createDiv();
    text.createEl('h3', { text: shelf ? shelf.name : 'All books' });
    text.createDiv({ cls: 'a4r-shelf-sub', text: `${count} ${count === 1 ? 'book' : 'books'}${shelf ? ' on this shelf' : ''}` });
    if (!shelf) return;
    const more = head.createEl('button', { cls: 'a4r-shelf-more', text: '⋯', attr: { 'aria-label': 'Shelf options' } });
    more.onclick = (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('Rename shelf').setIcon('pencil').onClick(() => { this.renamingShelf = shelf.name; rerender(); }));
      menu.addItem((i) => i.setTitle('Delete shelf').setIcon('trash').onClick(() => {
        new ConfirmModal(this.app, `Delete the "${shelf.name}" shelf?`, 'Its books stay in your library. They just stop being on this shelf.', async () => {
          await this.store.deleteShelf(shelf.name);
          this.gridFilter.shelf = null;
          rerender();
        }).open();
      }));
      menu.showAtMouseEvent(e);
    };
  }

  // Every cover can be dragged onto a shelf; on a shelf, dropping one cover
  // on another moves it to that spot (left half: before, right half: after).
  makeBookCardDraggable(card, b, shelf, shown, rerender) {
    card.draggable = true;
    card.ondragstart = (e) => {
      this.dragBookPath = b.file.path;
      card.addClass('a4r-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', b.file.path); }
    };
    card.ondragend = () => { card.removeClass('a4r-dragging'); this.dragBookPath = null; };
    if (!shelf) return;
    const after = (e) => {
      const r = card.getBoundingClientRect();
      return r.width ? e.clientX > r.left + r.width / 2 : false;
    };
    card.ondragover = (e) => {
      if (!this.dragBookPath || this.dragBookPath === b.file.path || !shown.some((x) => x.file.path === this.dragBookPath)) return;
      e.preventDefault();
      card.toggleClass('a4r-drop-after', after(e));
      card.toggleClass('a4r-drop-before', !after(e));
    };
    card.ondragleave = () => { card.removeClass('a4r-drop-before'); card.removeClass('a4r-drop-after'); };
    card.ondrop = async (e) => {
      const dragged = this.dragBookPath;
      card.removeClass('a4r-drop-before');
      card.removeClass('a4r-drop-after');
      if (!dragged || dragged === b.file.path) return;
      e.preventDefault();
      this.dragBookPath = null;
      // The full saved order (not just what the current filters show), so a
      // search or status filter can't drop the hidden books out of it.
      const full = this.store.booksOnShelf(shelf.name).map((x) => x.file.path);
      await this.store.setShelfOrder(shelf.name, moveInOrder(full, dragged, b.file.path, after(e)));
      rerender();
    };
  }

  // Shelves row in the book's Details box (v0.12.0, mockup-shelves.html).
  renderShelvesField(side, file, fm) {
    const field = side.createDiv({ cls: 'a4r-field a4r-shelves-field' });
    field.createEl('label', { text: '📚 Shelves' });
    const onShelves = normShelfList(fm.shelves);
    const chips = field.createDiv({ cls: 'a4r-tag-row' });
    if (!onShelves.length) chips.createSpan({ cls: 'a4r-shelf-none', text: 'Not on any shelf yet.' });
    for (const name of onShelves) {
      const pill = chips.createDiv({ cls: 'a4r-tag a4r-shelf-chip' });
      pill.createSpan({ text: name });
      const x = pill.createEl('button', { cls: 'a4r-tag-remove', text: '×', attr: { 'aria-label': `Remove from ${name}` } });
      setTooltip(x, `Take off ${name}`);
      x.onclick = async () => { await this.store.removeBookFromShelf(file, name); this.render(); };
    }
    const row = field.createDiv({ cls: 'a4r-tag-add-row' });
    if (this.newShelfForDetail) {
      const input = row.createEl('input', { attr: { placeholder: 'New shelf name', 'aria-label': 'New shelf name', maxlength: String(SHELF_NAME_MAX) } });
      const addBtn = row.createEl('button', { text: '+ Add' });
      const save = async () => {
        const n = cleanShelfName(input.value);
        if (!n) return;
        const existing = this.store.findShelf(n);
        const name = existing ? existing.name : await this.store.createShelf(n);
        await this.store.addBookToShelf(file, name);
        this.newShelfForDetail = false;
        this.render();
      };
      addBtn.onclick = save;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); this.newShelfForDetail = false; this.render(); }
      };
      window.setTimeout(() => input.focus(), 0);
      return;
    }
    const sel = row.createEl('select', { attr: { 'aria-label': 'Add to a shelf' } });
    const lower = onShelves.map((n) => n.toLowerCase());
    for (const s of this.store.listShelves()) {
      if (!lower.includes(s.name.toLowerCase())) sel.createEl('option', { text: s.name, value: s.name });
    }
    sel.createEl('option', { text: 'New shelf…', value: '__new' });
    const addBtn = row.createEl('button', { text: '+ Add' });
    addBtn.onclick = async () => {
      if (sel.value === '__new') { this.newShelfForDetail = true; this.render(); return; }
      await this.store.addBookToShelf(file, sel.value);
      this.render();
    };
  }

  async handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.(pdf|epub)$/i.test(f.name));
    if (!files.length) { new Notice('Only .pdf and .epub files are supported.'); return; }
    let created = 0; let dup = 0; let failed = 0;
    for (const f of files) {
      try {
        const ab = await f.arrayBuffer();
        const buf = Buffer.from(ab);
        const guess = f.name.replace(/\.(pdf|epub)$/i, '').replace(/[_-]+/g, ' ').trim();
        const result = await this.store.createBookFromBuffer(buf, guess);
        if (result.ok === 'created') created += 1;
        else if (result.ok === 'duplicate') dup += 1;
        else failed += 1;
      } catch (err) {
        console.error('Reading Vault: upload failed', err);
        failed += 1;
      }
    }
    let msg = `Added ${created} book${created === 1 ? '' : 's'}.`;
    if (dup) msg += ` ${dup} already in your library.`;
    if (failed) msg += ` ${failed} failed.`;
    new Notice(msg);
    this.render();
  }

  // ==================== DETAIL ====================
  // Book summary (v0.14.0), beside the cover, built to the approved
  // docs/mockups/mockup-book-summary.html. Pro only (John, 2026-09-24).
  // Redraws only itself, so Show more, Edit and Write with AI never
  // rebuild the page.
  renderDetailSummary(el, file) {
    const plugin = this.plugin;
    const store = this.store;
    const draw = () => {
      if (this.currentBook !== file) return;
      el.empty();
      const head = el.createDiv({ cls: 'a4r-summary-h' });
      const k = head.createDiv({ cls: 'a4r-hl-h' });
      k.appendText('SUMMARY');
      if (!plugin.isPro()) {
        k.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });
        el.createDiv({ cls: 'a4r-summary-pro-note', text: 'With Pro, see a short summary of the book here, from the book itself or written by AI.' });
        return;
      }
      if (this.summaryWorking === file.path) {
        const w = el.createDiv({ cls: 'a4r-summary-working' });
        const dots = w.createSpan({ cls: 'a4r-summary-dots' });
        for (let i = 0; i < 3; i++) dots.createEl('i');
        w.appendText('Writing a summary with your AI service…');
        return;
      }
      store.getSummary(file).then((sum) => {
        if (this.currentBook !== file) return;
        drawWith(head, sum);
      }).catch((err) => console.error('Reading Vault: could not read the summary', err));
    };

    const aiButton = (parent, label) => {
      const b = parent.createEl('button', { cls: 'a4r-summary-btn', text: label });
      b.onclick = async () => {
        if (plugin.askReadiness() !== 'ready') {
          new Notice('Writing with AI uses your Ask the book key. Switch on Ask the book and add a key in Settings first.');
          plugin.openOwnSettings();
          return;
        }
        this.summaryWorking = file.path;
        draw();
        try {
          const res = await plugin.writeSummaryWithAi(file);
          await store.setSummary(file, res.text, { source: 'ai', ai: res.label });
          this.summaryExpanded = false;
        } catch (err) {
          new Notice((err && err.message) || "Couldn't write a summary.");
        } finally {
          this.summaryWorking = null;
          window.setTimeout(draw, 60); // let the note's frontmatter settle first
        }
      };
      return b;
    };

    const drawWith = (head, sum) => {
      if (this.editingSummary) {
        const ta = el.createEl('textarea', { cls: 'a4r-notes-textarea a4r-summary-textarea', attr: { 'aria-label': 'Summary' } });
        ta.value = sum.text;
        const row = el.createDiv({ cls: 'a4r-notes-save-row' });
        const save = row.createEl('button', { cls: 'a4r-btn-primary', text: 'Save' });
        save.onclick = async () => {
          save.disabled = true;
          const changed = ta.value.trim() !== sum.text.trim();
          try {
            await store.setSummary(file, ta.value, changed ? { source: 'you' } : { source: sum.source || 'you', ai: sum.ai });
          } catch (err) {
            console.error('Reading Vault: could not save the summary', err);
            new Notice("Couldn't save the summary. Your text is still in the box, so try again.");
            save.disabled = false;
            return;
          }
          this.editingSummary = false;
          window.setTimeout(draw, 60);
        };
        const cancel = row.createEl('button', { cls: 'a4r-summary-btn is-quiet', text: 'Cancel' });
        cancel.onclick = () => { this.editingSummary = false; draw(); };
        window.setTimeout(() => ta.focus(), 0);
        return;
      }

      if (!sum.text) {
        const box = el.createDiv({ cls: 'a4r-summary-empty' });
        const msg = box.createEl('p');
        const acts = box.createDiv({ cls: 'a4r-summary-actions' });
        const known = plugin._bookDescCache && plugin._bookDescCache.get(file.path);
        if (known === undefined) {
          msg.setText('No summary yet.');
          plugin._bookDescCache = plugin._bookDescCache || new Map();
          plugin.bookFileDetails(file).then((d) => {
            plugin._bookDescCache.set(file.path, d.description || null);
            if (this.currentBook === file && !this.editingSummary) draw();
          }).catch((err) => console.error('Reading Vault: could not read the book file', err));
        } else if (known) {
          msg.setText("This book's file has its own description.");
          const use = acts.createEl('button', { cls: 'a4r-summary-btn', text: "Use the book's description" });
          use.onclick = async () => {
            use.disabled = true;
            await store.setSummary(file, known, { source: 'book' });
            window.setTimeout(draw, 60);
          };
        } else {
          msg.setText("This book's file doesn't include a description.");
        }
        aiButton(acts, '✨ Write with AI');
        const own = acts.createEl('button', { cls: 'a4r-summary-btn', text: 'Write my own' });
        own.onclick = () => { this.editingSummary = true; draw(); };
        return;
      }

      const edit = head.createEl('button', { cls: 'a4r-notes-edit', text: '✎ Edit' });
      edit.onclick = () => { this.editingSummary = true; draw(); };
      // Cut to about the cover's height (John, 2026-09-24); "Show more"
      // only when something is actually hidden.
      const body = el.createDiv({ cls: `a4r-summary-text${this.summaryExpanded ? '' : ' is-clamped'}` });
      for (const p of sum.text.split(/\n\s*\n/)) body.createEl('p', { text: p.trim() });
      const long = this.summaryExpanded || body.scrollHeight > body.clientHeight + 2;
      if (!long) body.removeClass('is-clamped');

      const src = el.createDiv({ cls: 'a4r-summary-src' });
      if (sum.source === 'book') {
        src.appendText('From the ');
        src.createEl('b', { text: "book's own description" });
      } else if (sum.source === 'ai') {
        src.appendText('Written by ');
        src.createEl('b', { text: 'AI' });
        src.appendText(sum.ai ? ` (${sum.ai}). Check it against the book.` : '. Check it against the book.');
      } else {
        src.appendText('Edited by ');
        src.createEl('b', { text: 'you' });
      }
      const acts = el.createDiv({ cls: 'a4r-summary-actions' });
      if (long) {
        const more = acts.createEl('button', { cls: 'a4r-summary-btn is-quiet', text: this.summaryExpanded ? 'Show less' : 'Show more' });
        more.onclick = () => { this.summaryExpanded = !this.summaryExpanded; draw(); };
      }
      aiButton(acts, sum.source === 'ai' ? '↻ Write again' : '✨ Write a fuller one with AI');
    };

    draw();
  }

  renderDetail(body) {
    const file = this.currentBook;
    const fm = this.store.getFm(file);

    const titleRow = body.createDiv();
    titleRow.createDiv({ cls: 'a4r-format-pill', text: (fm.format || '').toUpperCase() });
    titleRow.createEl('h2', { cls: 'a4r-detail-title', text: fm.title || file.basename });
    titleRow.createDiv({ cls: 'a4r-detail-author', text: fm.author || '' });

    const top = body.createDiv({ cls: 'a4r-detail-top' });
    const leftCol = top.createDiv();

    const coverRow = leftCol.createDiv({ cls: 'a4r-detail-cover-row' });
    const leftBlock = coverRow.createDiv({ cls: 'a4r-detail-left-block' });
    const coverEl = leftBlock.createDiv({ cls: 'a4r-detail-cover' });
    if (fm.cover_path) {
      const img = coverEl.createEl('img');
      img.src = this.app.vault.adapter.getResourcePath(fm.cover_path);
    } else {
      const [bg, fg] = pickPlaceholderColor(fm.title || '');
      coverEl.style.background = bg; coverEl.style.color = fg;
      coverEl.createDiv({ text: fm.title || file.basename });
    }
    const progressRow = leftBlock.createDiv({ cls: 'a4r-progress-row' });
    const bar = progressRow.createDiv({ cls: 'a4r-bar' });
    const pct = typeof fm.progress_percent === 'number' ? Math.max(0, Math.min(100, fm.progress_percent)) : 0;
    const fill = bar.createDiv({ cls: 'a4r-fill' }); fill.style.width = `${pct}%`;
    const dot = bar.createDiv({ cls: 'a4r-dot' }); dot.style.left = `${Math.max(1, pct)}%`;
    progressRow.createSpan({ text: fmtPercent(fm.progress_percent) });
    const continueBtn = leftBlock.createEl('button', { cls: 'a4r-continue-btn' });
    continueBtn.setText(fm.progress_percent ? '📖 Continue Reading' : '📖 Start Reading');
    // v0.4.5: always rebuild the reader fresh from the book note's own
    // saved fm.last_page/last_cfi -- the same single source of truth
    // openBook() (Grid's own "open a book" path) already reads from --
    // instead of a bare goto('reader') that silently reused whatever
    // in-memory `this.reader` object happened to still be sitting around
    // from earlier this session (e.g. left pointed at a highlight jump
    // target). Reusing the SAME method Grid uses is what actually
    // guarantees Continue Reading and Grid always land on the same spot,
    // not just a similar-looking fix beside it. See the v0.4.5 fix notes.
    continueBtn.onclick = () => this.openBook(file, 'reader');
    // Book summary (v0.14.0) fills the space beside the cover.
    this.renderDetailSummary(coverRow.createDiv({ cls: 'a4r-summary' }), file);

    // Highlights section (full width of the left column — genuine empty
    // space sits to the right of the narrow cover block above, per brief).
    // Hidden (dismissed) highlights aren't shown, so they aren't counted
    // either (QA fix v0.17.3).
    const highlights = this.store.listHighlights(file.path).filter((h) => h.status !== 'dismissed');
    const hlHead = leftCol.createDiv({ cls: 'a4r-hl-h a4r-hl-h-row' });
    hlHead.createSpan({ text: `HIGHLIGHTS (${highlights.length})` });
    // Export highlights (v0.11.0), next to the heading per the approved mockup.
    if (highlights.length) {
      const exp = hlHead.createEl('button', { cls: 'a4r-export-open', text: '⤓ Export' });
      setTooltip(exp, "Export this book's highlights to a file");
      exp.onclick = () => this.plugin.openExport(file);
    }
    if (!highlights.length) {
      leftCol.createDiv({ cls: 'a4r-notes-empty', text: 'No highlights yet.' });
    }
    for (const h of highlights) {
      const card = leftCol.createDiv({ cls: 'a4r-hl-card' });
      const locRow = card.createDiv({ cls: 'a4r-loc' });
      const locLeft = locRow.createSpan();
      if (h.color) {
        const sw = locLeft.createSpan({ cls: 'a4r-swatch' });
        sw.style.background = h.color;
      }
      if (h.format === 'pdf') {
        locLeft.createSpan({ text: `PDF page ${h.location_page ?? '—'}` });
      }
      card.createDiv({ cls: 'a4r-quote', text: `"${h.excerpt}"` });
      if (h.status === 'linked' && h.topic_slug) {
        const link = card.createEl('button', { cls: 'a4r-topic-link', text: `→ ${h.topic_path ? h.topic_path.split('/').pop().replace(/\.md$/, '') : h.topic_slug}` });
        link.onclick = () => { if (h.topic_path) this.app.workspace.openLinkText(h.topic_path, '', true); };
      } else {
        const link = card.createEl('button', { cls: 'a4r-topic-link a4r-unlinked', text: '→ link to a topic' });
        link.onclick = () => this.goto('highlights');
      }
      const actions = card.createDiv({ cls: 'a4r-hl-card-actions' });
      const del = actions.createEl('button', { text: 'Delete' });
      del.onclick = () => new ConfirmModal(this.app, 'Delete highlight?', 'This permanently removes this highlight note.', async () => {
        await this.store.deleteHighlight(h.file);
        this.render();
      }).open();
    }

    // Bookmarks section (v0.3.0) — every saved spot, in reading order,
    // reachable without opening the Reader first. Uses the same book note
    // frontmatter `bookmarks` array the Reader's own Bookmarks tab reads;
    // no live reader session exists here, so location labels use a plain
    // spine-index-based "Chapter N" (no real TOC/chapter-title lookup,
    // which would mean parsing the EPUB just to render this list).
    const bookmarks = Array.isArray(fm.bookmarks) ? fm.bookmarks : [];
    const bmHead = leftCol.createDiv({ cls: 'a4r-hl-h', text: `BOOKMARKS (${bookmarks.length})` });
    bmHead.style.marginTop = '20px';
    if (!bookmarks.length) {
      leftCol.createDiv({ cls: 'a4r-notes-empty', text: 'No bookmarks yet.' });
    } else {
      const bmBox = leftCol.createDiv({ cls: 'a4r-detail-bm-box' });
      for (const bm of bookmarks) {
        const row = bmBox.createDiv({ cls: 'a4r-detail-bm-row' });
        setTooltip(row, 'Jump into the Reader at this spot');
        const left = row.createDiv();
        const loc = this.describeBookmarkLocationForDetail(bm);
        left.createDiv({ cls: 'a4r-detail-bm-label', text: bm.label || loc });
        left.createDiv({ cls: 'a4r-detail-bm-loc', text: loc });
        row.createSpan({ cls: 'a4r-detail-bm-hint', text: '→ open in Reader' });
        row.onclick = () => this.openBookmarkFromDetail(bm, file);
      }
    }

    // Words (v0.13.0): words saved with Look up from this book.
    const wordFiles = this.store.listWordFiles(file.path);
    if (wordFiles.length) {
      const wHead = leftCol.createDiv({ cls: 'a4r-hl-h', text: `WORDS (${wordFiles.length})` });
      wHead.style.marginTop = '20px';
      const wBox = leftCol.createDiv({ cls: 'a4r-detail-bm-box a4r-detail-words' });
      for (const wf of wordFiles) {
        const row = wBox.createDiv({ cls: 'a4r-detail-bm-row' });
        setTooltip(row, 'Open this word\'s note');
        const left = row.createDiv();
        left.createDiv({ cls: 'a4r-detail-bm-label', text: this.store.getFm(wf).word || wf.basename });
        const meaningEl = left.createDiv({ cls: 'a4r-detail-bm-loc' });
        this.app.vault.cachedRead(wf).then((t) => {
          const m = /\*\*Meaning:\*\*\s*(.+)/.exec(t);
          if (m) meaningEl.setText(truncate(m[1], 80));
        }).catch(() => {});
        row.onclick = () => this.app.workspace.openLinkText(wf.path, '', 'tab');
      }
    }

    // Notes section
    const notesHead = leftCol.createDiv({ cls: 'a4r-notes-h' });
    notesHead.createDiv({ cls: 'a4r-hl-h', text: 'NOTES' });
    const editBtn = notesHead.createEl('button', { cls: 'a4r-notes-edit', text: this.editingNotes ? '✕ Cancel' : '✎ Edit' });
    editBtn.onclick = () => { this.editingNotes = !this.editingNotes; this.render(); };

    if (this.editingNotes) {
      this.store.getNotesBody(file).then((text) => {
        const ta = leftCol.createEl('textarea', { cls: 'a4r-notes-textarea' });
        ta.value = text;
        const saveRow = leftCol.createDiv({ cls: 'a4r-notes-save-row' });
        const saveBtn = saveRow.createEl('button', { cls: 'a4r-btn-primary', text: 'Save' });
        saveBtn.onclick = async () => {
          saveBtn.disabled = true;
          try {
            await this.store.setNotesBody(file, ta.value);
          } catch (err) {
            console.error('Reading Vault: could not save notes', err);
            new Notice("Couldn't save your notes. Your text is still in the box, so try again.");
            saveBtn.disabled = false;
            return;
          }
          this.editingNotes = false;
          this.render();
        };
      });
    } else {
      this.store.getNotesBody(file).then((text) => {
        if (!text.trim()) leftCol.createDiv({ cls: 'a4r-notes-empty', text: 'No notes yet.' });
        else leftCol.createDiv({ cls: 'a4r-notes-body', text });
      });
    }

    // Sidebar
    const side = top.createDiv({ cls: 'a4r-side-card' });
    side.createDiv({ cls: 'a4r-side-h', text: 'Details' });

    const statusField = side.createDiv({ cls: 'a4r-field' });
    statusField.createEl('label', { text: 'Status' });
    const statusSel = statusField.createEl('select');
    for (const s of VALID_STATUSES) statusSel.createEl('option', { text: STATUS_LABELS[s], value: s });
    statusSel.value = fm.status || 'to-read';
    statusSel.onchange = async () => { await this.store.setBookStatus(file, statusSel.value); this.render(); };
    // "Mark as finished" (v0.8.0) -- one click sets status + date_finished,
    // which the Reading Dashboard's yearly goal and finished shelf count.
    const finishedRow = statusField.createDiv({ cls: 'a4r-finished-row' });
    if (fm.status === 'finished') {
      const when = fm.date_finished ? parseDayKey(String(fm.date_finished)) : null;
      finishedRow.createSpan({ cls: 'a4r-finished-note', text: when ? `✓ Finished ${fmtMonthDay(when)}, ${when.getFullYear()}` : '✓ Finished' });
    } else {
      const finBtn = finishedRow.createEl('button', { cls: 'a4r-finish-btn', text: '✓ Mark as finished' });
      setTooltip(finBtn, 'Counts toward your yearly goal on the Reading Dashboard');
      finBtn.onclick = async () => {
        await this.store.setBookStatus(file, 'finished');
        new Notice(`Marked "${fm.title || file.basename}" as finished.`);
        this.render();
      };
    }

    const tagsField = side.createDiv({ cls: 'a4r-field' });
    tagsField.createEl('label', { text: '🏷 Tags' });
    const tagRow = tagsField.createDiv({ cls: 'a4r-tag-row' });
    const tags = normTagList(fm.tags);
    for (const t of tags) {
      const pill = tagRow.createDiv({ cls: 'a4r-tag' });
      pill.createSpan({ text: t });
      const x = pill.createEl('button', { cls: 'a4r-tag-remove', text: '×' });
      setTooltip(x, 'Remove tag');
      x.onclick = async () => { await this.store.removeTag(file, t); this.render(); };
    }
    const tagAddRow = tagsField.createDiv({ cls: 'a4r-tag-add-row' });
    const tagInput = tagAddRow.createEl('input', { attr: { placeholder: 'Add a tag…' } });
    const tagAddBtn = tagAddRow.createEl('button', { text: '+ Add' });
    const addTag = async () => {
      const v = tagInput.value.trim();
      if (!v || tags.includes(v)) return;
      await this.store.addTag(file, v);
      this.render();
    };
    tagAddBtn.onclick = addTag;
    tagInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } };

    this.renderShelvesField(side, file, fm);

    const coverField = side.createDiv({ cls: 'a4r-field' });
    coverField.createEl('label', { text: '🖼 Cover' });
    const coverInput = coverField.createEl('input', { type: 'file', attr: { accept: 'image/png,image/jpeg,image/gif,image/webp' } });
    coverInput.style.display = 'none';
    coverInput.onchange = async () => {
      const f = coverInput.files[0];
      if (!f) return;
      const buf = Buffer.from(await f.arrayBuffer());
      const result = await this.store.uploadCover(file, buf);
      if (result.ok !== 'updated') new Notice('Unsupported image type.');
      this.render();
    };
    const coverBtn = coverField.createEl('button', { cls: 'a4r-upload-btn', text: 'Upload cover' });
    coverBtn.onclick = () => coverInput.click();

    const deleteBtn = side.createEl('button', { cls: 'a4r-delete-btn', text: '🗑 Delete book' });
    deleteBtn.onclick = () => new ConfirmModal(
      this.app,
      'Delete this book?',
      `This permanently deletes "${fm.title || file.basename}", its file, its cover, and all of its highlights.`,
      async () => {
        await this.store.deleteBook(file);
        this.currentBook = null;
        this.goto('grid');
      },
    ).open();
  }

  // describeBookmarkLocationForDetail — Detail view has no live reader
  // session (no parsed EPUB spine/TOC in memory), so unlike the Reader's own
  // describeBookmarkLocation() this can't resolve a real chapter title —
  // just the spine index it was saved at. Good enough for "which rough part
  // of the book," and doesn't cost a full EPUB parse just to render a list.
  describeBookmarkLocationForDetail(bm) {
    if (bm.format === 'pdf') return `Page ${bm.location}`;
    const m = /^spine:(\d+)/.exec(String(bm.location || ''));
    return m ? `Chapter ${parseInt(m[1], 10) + 1}` : String(bm.location || '');
  }

  // openBookmarkFromDetail — a Detail-view Bookmarks-row click opens the
  // Reader landed on that exact bookmark, not the book's normal last-read
  // position. Tears down any reader state the same way openBook() does
  // (this can be called from a Detail page reached while a reader for this
  // same book was already open earlier in the session) so renderReader()'s
  // `if (!this.reader)` branch always runs fresh and picks up
  // `pendingBookmarkJump`.
  openBookmarkFromDetail(bm, file) {
    this.stopPlayback();
    this.flushProgress();
    if (this.reader && this.reader.epub && this.reader.epub.resizeObserver) this.reader.epub.resizeObserver.disconnect();
    this.releasePdf(this.reader);
    this.reader = null;
    this.pendingBookmarkJump = bm;
    this.goto('reader');
  }

  // openHighlightInReader — the book note's "Open in Reader" link lands
  // here via the open-reading-highlight protocol handler (see the plugin's
  // onload()). Unlike openBookmarkFromDetail() this can arrive with ANY
  // book (or none) currently loaded in the view, so it sets currentBook
  // itself, the same way openBook() does, before reusing the exact same
  // pendingBookmarkJump resume mechanism a real bookmark jump uses --
  // location_cfi/location_page are stored in the same "spine:idx[:page:n:
  // of:total]" / plain-page-number shapes a bookmark's own `location`
  // already is.
  openHighlightInReader(hlPath) {
    const hlFile = this.app.vault.getAbstractFileByPath(hlPath);
    if (!(hlFile instanceof TFile)) {
      new Notice('That highlight could not be found — it may have been deleted.');
      return;
    }
    const hfm = this.store.getFm(hlFile);
    const bookFile = hfm.book_path ? this.app.vault.getAbstractFileByPath(hfm.book_path) : null;
    if (!(bookFile instanceof TFile)) {
      new Notice("That highlight's book could not be found.");
      return;
    }
    this.stopPlayback();
    this.flushProgress();
    if (this.reader && this.reader.epub && this.reader.epub.resizeObserver) this.reader.epub.resizeObserver.disconnect();
    this.releasePdf(this.reader);
    this.currentBook = bookFile;
    this.reader = null;
    this._lastSavedListenPos = null;
    this._lastListenSaveAt = 0;
    // excerpt is carried along so the reader can fall back to finding the
    // passage by its own saved text when location_cfi/location_page can't
    // be resolved structurally -- e.g. a pre-A3-import highlight whose
    // location_cfi is a real `epubcfi(...)` string (this plugin's own
    // "spine:<n>[:page:<p>:of:<t>]" format never existed when it was
    // saved) never has a spine index to jump to at all. See
    // locateExcerptInEpub()/locateExcerptInPdf() and their callers.
    this.pendingBookmarkJump = hfm.format === 'pdf'
      ? { format: 'pdf', location: String(hfm.location_page ?? ''), excerpt: hfm.excerpt || '' }
      : { format: 'epub', location: hfm.location_cfi || '', excerpt: hfm.excerpt || '' };
    this.goto('reader');
  }

  // ==================== READER ====================
  // Renders into its own child container so a recursive re-render (page
  // turn, theme toggle, epub-just-finished-loading) only replaces the
  // toolbar+page area, never the chrome/tabs row rendered once by render().
  renderReader(appEl) {
    // A page turn (button, arrow key) or any re-render leaves the old
    // selection behind, so a still-open color picker must go with it.
    this.dismissHighlightPopup({ quiet: true });
    // A full re-render tears down the toolbar the "Aa" popover is nested
    // in (it's a real child of .a4r-rt-controls, not a document.body
    // overlay -- see showTextSettingsPopover()) -- dismiss it first so its
    // outside-click/Escape/resize listeners don't leak past their own DOM.
    this.dismissTextSettingsPopover();
    const existing = appEl.querySelector(':scope > .a4r-reader-content');
    if (existing) existing.remove();
    const content = appEl.createDiv({ cls: 'a4r-reader-content' });

    const file = this.currentBook;
    const fm = this.store.getFm(file);
    const toolbar = content.createDiv({ cls: 'a4r-reader-toolbar' });
    const titleEl = toolbar.createDiv({ cls: 'a4r-rt-title' });
    titleEl.createSpan({ text: fm.title || file.basename });
    titleEl.createSpan({ cls: 'a4r-author', text: fm.author ? ` · ${fm.author}` : '' });

    const controls = toolbar.createDiv({ cls: 'a4r-rt-controls' });
    const locPct = controls.createSpan({ cls: 'a4r-loc-pct' });
    // "Back to p. N" chip (v0.5.0) -- sits right beside the p.X/Y · N%
    // indicator it explains, per the approved mockup. Populated/shown by
    // updateBackToPosChip() below, once `r` exists.
    const backToPosEl = controls.createSpan({ cls: 'a4r-back-to-pos' });
    backToPosEl.style.display = 'none';
    const tocBtn = controls.createEl('button', { cls: 'a4r-rt-icon-btn', text: '☰' });
    setTooltip(tocBtn, 'Contents / Bookmarks / Highlights');
    const searchBtn = controls.createEl('button', { cls: 'a4r-rt-icon-btn', text: '🔍' });
    setTooltip(searchBtn, 'Search this book');
    const bmBtn = controls.createEl('button', { cls: 'a4r-rt-icon-btn', text: '🔖' });
    // 🎧 (v0.7.0) -- toggles the Listen bar / reading progress strip, per
    // the approved mockup. Only offered when the Listen feature itself is
    // even possible on this Mac (window.speechSynthesis) -- same gate the
    // Listen bar build below already uses; no button to show/hide a
    // feature that was never available in the first place.
    const listenToggleBtn = window.speechSynthesis
      ? controls.createEl('button', { cls: 'a4r-rt-icon-btn', text: '🎧' })
      : null;
    // "Aa" (v0.6.0) -- replaces the old separate A-/A+ pair and Auto/Dark/
    // Light switch with one popover (font, size, line spacing, margins,
    // justify, page look), per the approved mockup. See
    // showTextSettingsPopover()/applyTextSettings() below.
    const aaBtn = controls.createEl('button', { cls: 'a4r-rt-aa-btn', text: 'Aa' });
    setTooltip(aaBtn, 'Text settings');
    // Full screen (v0.15.0), built to the approved mockup-full-screen.html:
    // the button at the end of the toolbar, and "Exit full screen" in its
    // place while full screen (the toolbar becomes the slim bar at the top).
    const fsBtn = controls.createEl('button', { cls: 'a4r-rt-icon-btn a4r-rt-fs-btn', attr: { 'aria-label': 'Full screen' } });
    fsBtn.appendChild(fullScreenIcon());
    setTooltip(fsBtn, 'Full screen');
    fsBtn.onclick = () => this.enterFullScreen();
    const fsExit = controls.createEl('button', { cls: 'a4r-rt-fs-exit' });
    fsExit.appendText('Exit full screen ');
    fsExit.createEl('kbd', { text: 'Esc' });
    fsExit.onclick = () => this.exitFullScreen();
    const fsWhere = titleEl.createSpan({ cls: 'a4r-rt-fs-where' });
    const fsProgress = content.createDiv({ cls: 'a4r-fs-progress' });
    const fsProgressFill = fsProgress.createDiv({ cls: 'a4r-fs-progress-fill' });
    const fsPct = content.createDiv({ cls: 'a4r-fs-pct' });

    if (!this.reader) {
      this.reader = {
        format: fm.format,
        // Text size used to live here (reset to 16 every session, never
        // persisted -- see the DEFAULT_SETTINGS.textSize comment above);
        // it and every other Text-settings control now read straight from
        // this.plugin.settings (global, applied live) instead of a
        // per-reader copy.
        theme: ['auto', 'dark', 'light'].includes(this.plugin.settings.pageColour) ? this.plugin.settings.pageColour : 'auto',
        dirty: false,
        saveTimer: null,
        pdf: { page: 1, pageCount: fm.page_count || null },
        epub: {
          buf: null, entries: null, opfDir: null, spine: [], idx: 0, loaded: false,
          page: 0, pageWidth: 0, pageGap: 56, pageCountInChapter: 1, pendingPageFraction: null, resizeObserver: null,
        },
        tts: null, // built by rebuildTtsSentences() once a chapter's DOM exists
        // Contents/Bookmarks/Highlights (☰, one panel, three tabs, v0.3.0) /
        // Search (🔍, its own overlay) — uiPanel is null or one of
        // 'side'|'search'; sidePanelTab picks which of the three tabs the
        // side panel shows. Search index and PDF outline are built lazily
        // (first time needed) and cached on the reader state for the rest of
        // this reading session; all of it is cleared by openBook() building
        // a fresh `this.reader` object.
        uiPanel: null,
        sidePanelTab: 'toc',
        searchQuery: '',
        bookmarks: null, // authoritative cache, set on first read and after every add/remove/label edit -- see addBookmark/removeBookmark/updateBookmarkLabel
        editingBookmarkId: null, // bookmark currently showing its rename-in-place row in the Bookmarks tab
        followScroll: true, // Listen keeps the spoken sentence in view until the user scrolls by hand -- see followScrollToSentence()
        backToPos: null, // "Back to p. N" chip (v0.5.0) -- {format, idx, page, label} of the saved reading position a jump just landed away from, or null when reading normally. See beginJump()/resolvePendingBackToPos()/scheduleProgressSave().
      };
      this.reader.pdf.outline = undefined; // undefined = not loaded yet, null = loaded, book has none
      this.reader.pdf.searchIndex = null;
      this.reader.epub.searchIndex = null;
      if (fm.format === 'pdf' && typeof fm.last_page === 'number') this.reader.pdf.page = fm.last_page;
      // A Detail-view "Bookmarks (n)" row jump (see openBookmarkFromDetail)
      // lands here as a raw bookmark to open at instead of the book's normal
      // last-read position -- PDF is simple (just override the page number
      // below); EPUB needs the spine/page applied inside the load branch
      // further down, since the load branch's own fm.last_cfi resume logic
      // would otherwise stomp it once the chapter buffer finishes loading.
      const pendingBm = this.pendingBookmarkJump;
      this.pendingBookmarkJump = null;
      if (pendingBm) {
        // Opened straight into a jump (a book note's "Open in Reader" link,
        // or a Detail-view Bookmarks row) rather than a normal "resume
        // reading" open -- same "Back to p. N" posture as an in-Reader jump
        // (v0.5.0): beginJump() reads fm.last_page/last_cfi (the real saved
        // position, untouched by this) before pendingBm overrides anything
        // below.
        this.beginJump(this.reader, file);
        if (pendingBm.format === 'pdf') {
          const p = parseInt(pendingBm.location, 10);
          if (Number.isFinite(p)) this.reader.pdf.page = p;
          // No parseable page number (e.g. a highlight whose location_page
          // was never captured) -- fall back to finding the excerpt's own
          // text once the PDF's real pages are available, see
          // locateExcerptInPdf() in renderPdfPage.
          else if (pendingBm.excerpt) this.reader.pdf.pendingTextExcerpt = pendingBm.excerpt;
        } else {
          this.reader.epub.initialBookmark = pendingBm;
        }
      }
      this.markBookStarted(file);
    }
    const r = this.reader;
    if (!Array.isArray(r.bookmarks)) {
      const bfm = this.store.getFm(file);
      r.bookmarks = Array.isArray(bfm.bookmarks) ? bfm.bookmarks : [];
    }

    // Listen (read-aloud) play bar — sits between the title bar and the
    // page, epub only (needs a text DOM to split into sentences; not built
    // for PDF pages' text layer yet) and
    // only when the Web Speech API is actually present.
    if (r.format === 'epub' || r.format === 'pdf') {
      // A failure here (e.g. this.plugin.settings not ready yet) must not
      // take down the rest of renderReader() -- bodyWrap/pageWrap/prev/next
      // are created right after this and the chapter itself renders inside
      // them; losing the Listen bar/progress strip is a much smaller
      // problem than losing the whole reader.
      //
      // v0.7.0: exactly one of the two ever shows in this one slot (per the
      // approved mockup's "no duplicate" rule) -- the Listen bar itself
      // already carries its own "N min left in chapter" + meter while it's
      // actually relevant (playing/paused), so showing the progress strip
      // underneath at the same time would just repeat the same number
      // twice. Listen bar shown only when speech is even possible on this
      // Mac AND the user hasn't hidden it; the strip covers every other
      // case, including "no speechSynthesis at all" (nothing else would
      // ever occupy this slot then).
      const showListen = !!window.speechSynthesis && (!this.plugin.settings.listenBarHidden || this.fullScreen);
      try {
        if (showListen) this.buildListenBar(content, r, appEl);
        else this.buildProgressStrip(content, r, appEl);
      } catch (err) {
        console.error('Reading Vault: Listen bar/progress strip failed to build', err);
      }
    }

    const bodyWrap = content.createDiv({ cls: 'a4r-reader-body' });
    const prev = bodyWrap.createEl('button', { cls: 'a4r-nav-circle', text: '‹' });
    setTooltip(prev, 'Previous page');
    let sidePanelEl = null;
    if (r.uiPanel === 'side') {
      sidePanelEl = bodyWrap.createDiv({ cls: 'a4r-side-panel' });
      this.renderSidePanel(sidePanelEl, r, appEl);
    }
    const pageWrap = bodyWrap.createDiv({ cls: 'a4r-reader-page-wrap' });
    const next = bodyWrap.createEl('button', { cls: 'a4r-nav-circle', text: '›' });
    setTooltip(next, 'Next page');
    r.prevBtn = prev;
    r.nextBtn = next;

    tocBtn.toggleClass('a4r-on', r.uiPanel === 'side');
    searchBtn.toggleClass('a4r-on', r.uiPanel === 'search');
    // 🔖 is a one-job toggle now (v0.3.0): bookmark the page you're on, or
    // remove that page's bookmark if it already has one -- never opens a
    // panel itself (☰ does that). "Lit" (a4r-bm-lit) is a different look
    // from a4r-on's "this panel is open" accent-fill on purpose, so the two
    // kinds of state (a toggled setting vs. an open panel) don't look alike.
    // updateBookmarkBtn — re-evaluates "is the CURRENT page bookmarked" and
    // re-lights bmBtn accordingly. Exposed on `r` (same pattern as
    // updateLocPct/updateBackToPosChip below) because the epub resize/
    // reflow observer moves r.epub.page on its own, outside a full
    // renderReader() pass (see layoutEpubColumns's ResizeObserver) -- v0.5.0
    // bug: that observer refreshed the page-% readout and the "Back to p.N"
    // chip after a reflow-driven page shift, but never this button, so a
    // reflow (opening/closing the ☰ side panel, a window resize, an Obsidian
    // pane-width drag) could silently leave 🔖 showing the lit state from
    // before the shift while r.epub.page had already moved off the
    // bookmarked page. The button then looked "stuck": pressing it read the
    // page it's REALLY on now (no bookmark there) and added a new one
    // instead of removing the one the user could still see highlighted
    // pre-shift -- visually a no-op each time (added-then-re-lit looks
    // identical to already-lit), but a fresh duplicate bookmark landed in
    // frontmatter on every press.
    const updateBookmarkBtn = () => {
      const currentBm = this.findBookmarkForCurrentPage(r);
      bmBtn.toggleClass('a4r-bm-lit', !!currentBm);
      setTooltip(bmBtn, currentBm ? 'Remove bookmark from this page' : 'Bookmark this page');
    };
    updateBookmarkBtn();
    r.updateBookmarkBtn = updateBookmarkBtn;
    if (listenToggleBtn) {
      const barHidden = !!this.plugin.settings.listenBarHidden;
      listenToggleBtn.toggleClass('a4r-on', !barHidden);
      setTooltip(listenToggleBtn, barHidden ? 'Show the Listen bar' : 'Hide the Listen bar');
      listenToggleBtn.onclick = () => (barHidden ? this.showListenBar(appEl) : this.hideListenBar(appEl));
      // Full screen: the Listen controls only show while it's playing, so
      // 🎧 starts (or pauses) Listen instead of showing or hiding its bar.
      if (this.fullScreen) {
        listenToggleBtn.toggleClass('a4r-on', false);
        setTooltip(listenToggleBtn, 'Listen');
        listenToggleBtn.onclick = () => this.onPlayButtonClick(appEl);
      }
    }
    tocBtn.onclick = () => { r.uiPanel = r.uiPanel === 'side' ? null : 'side'; this.renderReader(appEl); };
    searchBtn.onclick = () => { r.uiPanel = r.uiPanel === 'search' ? null : 'search'; this.renderReader(appEl); };
    bmBtn.onclick = async () => {
      const existing = this.findBookmarkForCurrentPage(r);
      if (existing) {
        r.bookmarks = await this.store.removeBookmark(file, existing.id);
      } else {
        const location = this.currentLocationString(r);
        const label = this.computeDefaultBookmarkLabel(r, pageWrap);
        const { bookmarks } = await this.store.addBookmark(file, { label, location, format: r.format });
        r.bookmarks = bookmarks;
      }
      this.renderReader(appEl);
    };

    // Toolbar readout (v0.7.1) -- whole-book position only ("5% of book").
    // The page-within-chapter used to be crammed in here too ("p.36/42 ·
    // 5%"), mixing two different denominators in one label; that now lives
    // on the reading-progress strip (chapter name + chapter page) and, while
    // the strip is replaced by the Listen bar, on the Listen bar's own
    // chapter line. PDF pages ARE whole-book pages (no separate chapter
    // denominator), so "p. N of M" stays here for PDF.
    const updateLocPct = () => {
      if (r.format === 'pdf') {
        locPct.setText(r.pdf.pageCount ? `p. ${r.pdf.page} of ${r.pdf.pageCount}` : `page ${r.pdf.page}`);
      } else if (!r.epub.spine.length) {
        locPct.setText('…');
      } else {
        const pct = computeEpubProgressPercent(r.epub.spine, r.epub.entries, r.epub.idx, r.epub.pageCountInChapter, r.epub.page);
        locPct.setText(`${fmtPercent(pct)} of book`);
      }
      // Full screen's thin line along the bottom and the slim bar's
      // "chapter · p. N of M" (v0.15.0).
      let bookPct = null;
      if (r.format === 'pdf') bookPct = r.pdf.pageCount ? (100 * r.pdf.page) / r.pdf.pageCount : null;
      else if (r.epub.spine.length) bookPct = computeEpubProgressPercent(r.epub.spine, r.epub.entries, r.epub.idx, r.epub.pageCountInChapter, r.epub.page);
      fsProgressFill.style.width = `${bookPct == null ? 0 : Math.max(0, Math.min(100, bookPct))}%`;
      fsPct.setText(bookPct == null ? '' : fmtPercent(bookPct));
      let where = '';
      try {
        const d = this.computeProgressStripData(r, file, this.store.getFm(file));
        where = d && d.label ? d.label : '';
      } catch { /* the slim bar just shows the title */ }
      fsWhere.setText(where ? ` · ${where}` : '');
    };
    updateLocPct();
    r.updateLocPct = updateLocPct;

    // "Back to p. N" chip (v0.5.0) -- visible only while r.backToPos is set
    // (a jump landed away from the saved position and hasn't been tapped or
    // cleared by real reading yet). See beginJump()/resolvePendingBackToPos().
    const updateBackToPosChip = () => {
      backToPosEl.empty();
      if (!r.backToPos) {
        backToPosEl.style.display = 'none';
        backToPosEl.onclick = null;
        return;
      }
      backToPosEl.style.display = '';
      backToPosEl.createSpan({ cls: 'a4r-bp-arrow', text: '↩' });
      backToPosEl.appendText(` Back to ${r.backToPos.label}`);
      setTooltip(backToPosEl, `Return to ${r.backToPos.label}, where you were reading before this jump`);
      backToPosEl.onclick = () => this.returnToBackToPos(r, appEl);
    };
    updateBackToPosChip();
    r.updateBackToPosChip = updateBackToPosChip;

    // "Aa" popover (v0.6.0) -- open/close only; the popover's own controls
    // (font, size, spacing, margins, justify, page look) are built by
    // renderTextSettingsBody() and apply live via applyTextSettings()/
    // applyPageColourLive(), never a full renderReader() (which would tear
    // the popover down while someone's mid-adjustment).
    aaBtn.toggleClass('a4r-on', this._textSettingsPopover != null);
    aaBtn.onclick = () => {
      if (this._textSettingsPopover) this.dismissTextSettingsPopover();
      else this.showTextSettingsPopover(aaBtn, r, pageWrap, appEl);
    };

    if (r.format === 'pdf') {
      this.renderPdfPage(pageWrap, file, fm, r, appEl);
      prev.disabled = r.pdf.page <= 1;
      next.disabled = !!r.pdf.pageCount && r.pdf.page >= r.pdf.pageCount;
      // A page turn by hand stops the voice (the voice's own page turns go
      // through pdfFollowSentence, not these buttons).
      prev.onclick = () => { this.pdfStopListenOnHandTurn(); r.pdf.page = Math.max(1, r.pdf.page - 1); this.plugin.sessionRecorder.notePageTurn(this.bookInfo(), 'read'); this.scheduleProgressSave(); this.renderReader(appEl); };
      next.onclick = () => { this.pdfStopListenOnHandTurn(); r.pdf.page += 1; this.plugin.sessionRecorder.notePageTurn(this.bookInfo(), 'read'); this.scheduleProgressSave(); this.renderReader(appEl); };
    } else {
      // Real disabled/onclick wiring happens inside renderEpubPage once this
      // chapter's page count is known (synchronous except on the very first
      // load of the EPUB, which re-enters renderReader() when it resolves).
      prev.disabled = true;
      next.disabled = true;
      this.renderEpubPage(pageWrap, file, fm, r, appEl);
    }

    // Appended AFTER the calls above: both renderPdfPage/renderEpubPage
    // start with pageWrap.empty(), which would otherwise wipe these back
    // out. Safe regardless of whether that call is still mid-flight (PDF
    // page draws are always awaited even on a cached doc; the epub side is
    // effectively synchronous once its buffer is cached) because pageWrap
    // itself -- unlike its children -- is never replaced this render pass.
    if (r.uiPanel === 'search') this.renderSearchOverlay(pageWrap, r, appEl);
  }

  // ==================== CONTENTS / SEARCH / BOOKMARKS ====================

  currentLocationString(r) {
    if (r.format === 'pdf') return String(r.pdf.page);
    const total = r.epub.pageCountInChapter || 1;
    return `spine:${r.epub.idx}:page:${r.epub.page || 0}:of:${total}`;
  }

  describeBookmarkLocation(bm, r) {
    if (bm.format === 'pdf') return `Page ${bm.location}`;
    const m = /^spine:(\d+)/.exec(String(bm.location || ''));
    if (!m) return String(bm.location || '');
    const idx = parseInt(m[1], 10);
    const chapters = r.epub.tocChapters || [];
    const info = chapters.length ? findChapterForSpineIdx(chapters, idx) : null;
    return info ? `Ch. ${info.number}` : `Chapter ${idx + 1}`;
  }

  // parseBookmarkLocation — the epub half of a bookmark's `location` string
  // ("spine:<idx>:page:<page>:of:<total>", or the legacy bare "spine:<idx>")
  // back into {idx, page}. Used only for the toggle button's "is the CURRENT
  // page already bookmarked" check, so it deliberately drops the "of:<total>"
  // part -- two reads of the same page can measure a slightly different
  // total page count for the chapter (pane resize, font-size change) without
  // the page itself having moved, and comparing idx+page (not the fraction)
  // is what actually answers "is this the same page."
  parseBookmarkLocation(loc) {
    const m = /^spine:(\d+)(?::page:(\d+))?/.exec(String(loc || ''));
    if (!m) return null;
    return { idx: parseInt(m[1], 10), page: m[2] !== undefined ? parseInt(m[2], 10) : 0 };
  }

  // findBookmarkForCurrentPage — the one-bookmark-per-page rule the 🔖
  // toggle depends on: is there already a bookmark AT the page the reader is
  // showing right now (not "anywhere in this book").
  findBookmarkForCurrentPage(r) {
    const list = Array.isArray(r.bookmarks) ? r.bookmarks : [];
    if (r.format === 'pdf') {
      return list.find((b) => b.format === 'pdf' && parseInt(b.location, 10) === r.pdf.page) || null;
    }
    return list.find((b) => {
      if (b.format === 'pdf') return false;
      const p = this.parseBookmarkLocation(b.location);
      return p && p.idx === r.epub.idx && p.page === (r.epub.page || 0);
    }) || null;
  }

  // getCurrentPageVisibleText — the raw text actually on screen right now,
  // used only to build a bookmark's default name. PDF: the page's real
  // text layer already holds exactly one page's text, nothing else to
  // filter. EPUB: the chapter's whole text lives in `columnsHost` at once
  // (CSS multi-column layout, see layoutEpubColumns) with everything but the
  // current page clipped out by the viewport's `overflow:hidden` -- so
  // "visible" is answered by intersecting each text node's real client rect
  // against the viewport's own rect, the same DOM-geometry approach
  // `computeRangePage`/`jumpToSearchResult` already use elsewhere in this
  // file, just walking every text node instead of one known range.
  getCurrentPageVisibleText(r, pageWrap) {
    if (r.format === 'pdf') {
      const textLayer = pageWrap.querySelector('.a4r-pdf-page .textLayer');
      return textLayer ? textLayer.textContent : '';
    }
    const columnsHost = r.epub.columnsHost;
    const viewport = columnsHost && columnsHost.parentElement;
    if (!columnsHost || !viewport) return '';
    let vRect;
    try { vRect = viewport.getBoundingClientRect(); } catch { return ''; }
    if (!vRect || vRect.width <= 0 || vRect.height <= 0) return '';
    const walker = document.createTreeWalker(columnsHost, NodeFilter.SHOW_TEXT, null);
    let out = '';
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent;
      if (text && text.trim()) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          for (let i = 0; i < rects.length; i += 1) {
            const rect = rects[i];
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.left < vRect.right && rect.right > vRect.left && rect.top < vRect.bottom && rect.bottom > vRect.top) {
              out += (out ? ' ' : '') + text.replace(/\s+/g, ' ').trim();
              break;
            }
          }
        } catch { /* a detached/invalid range just contributes nothing */ }
      }
      if (out.length > 300) break; // plenty for a default-name snippet
      node = walker.nextNode();
    }
    return out.trim();
  }

  // computeDefaultBookmarkLabel — "first words actually on the page" + the
  // page number the reader's own toolbar already shows for this spot (epub:
  // page-within-chapter, matching updateLocPct's own p.X; pdf: the real page
  // number), per the approved mockup. Falls back to just the page number
  // when the page's text can't be read (e.g. the PDF text layer hasn't
  // finished rendering yet) rather than leaving the bookmark unlabeled.
  computeDefaultBookmarkLabel(r, pageWrap) {
    const pageNum = r.format === 'pdf' ? r.pdf.page : (r.epub.page || 0) + 1;
    const raw = this.getCurrentPageVisibleText(r, pageWrap);
    if (!raw) return `p.${pageNum}`;
    const MAX = 60;
    let snippet = raw;
    let cut = false;
    if (raw.length > MAX) {
      snippet = raw.slice(0, MAX);
      const sp = snippet.lastIndexOf(' ');
      if (sp > 20) snippet = snippet.slice(0, sp);
      cut = true;
    }
    return `"${snippet}${cut ? '…' : ''}" · p.${pageNum}`;
  }

  jumpToBookmark(bm, r, appEl) {
    this.beginJump(r, this.currentBook);
    if (bm.format === 'pdf') {
      const p = parseInt(bm.location, 10);
      if (Number.isFinite(p)) { this.pdfStopListenOnHandTurn(); r.pdf.page = p; }
    } else {
      this.epubStopListenOnJump(r);
      const m = /^spine:(\d+)(?::page:(\d+):of:(\d+))?$/.exec(String(bm.location || ''));
      if (m) {
        const idx = parseInt(m[1], 10);
        if (Number.isFinite(idx)) r.epub.idx = idx;
        if (m[2] !== undefined && m[3] !== undefined) {
          const savedPage = parseInt(m[2], 10);
          const savedTotal = parseInt(m[3], 10);
          r.epub.pendingPageFraction = pageFraction(savedPage, savedTotal);
        } else {
          r.epub.page = 0;
        }
      }
    }
    r.uiPanel = null;
    // v0.4.5: a bookmark jump is a "take me here" click, not "I kept
    // reading" -- must never overwrite the saved last_page/last_cfi. See
    // the v0.4.5 fix notes (jumpToHighlight/jumpToSearchResult/TOC rows
    // all had the same bug).
    this.renderReader(appEl);
  }

  // jumpToHighlight — same posture as jumpToSearchResult: PDF always lands
  // on the exact saved page (or, failing that, finds the page by the
  // highlight's own excerpt text -- see locateExcerptInPdf); EPUB always
  // lands on the right chapter (structurally from "spine:<idx>", or -- for
  // a location_cfi predating this plugin's own location format entirely,
  // e.g. a real `epubcfi(...)` string carried over from A3 -- by finding
  // the chapter containing the excerpt's own text, see
  // locateExcerptInEpub) and best-effort re-locates the excerpt's own page
  // within it (a highlight note that predates page capture only ever
  // stored the chapter, "spine:<idx>", not a page).
  async jumpToHighlight(h, r, appEl) {
    this.beginJump(r, this.currentBook);
    r.uiPanel = null;
    const jumpToPageInChapter = () => {
      const columnsHost = r.epub.columnsHost;
      if (!columnsHost || !h.excerpt) return;
      const range = this.findTextRange(columnsHost, h.excerpt, ReadingView.chapterFractionOf(h.location_cfi)) || this.findTextRangeFuzzy(columnsHost, h.excerpt);
      if (range) {
        const target = this.computeRangePage(range, columnsHost, r);
        if (target !== r.epub.page) { r.epub.page = target; this.renderReader(appEl); }
      }
    };
    if (h.format === 'pdf') {
      this.pdfStopListenOnHandTurn();
      if (typeof h.location_page === 'number') {
        r.pdf.page = h.location_page;
      } else if (h.excerpt) {
        const page = await this.locateExcerptInPdf(r, h.excerpt);
        if (this.reader !== r) return; // book was closed/changed mid-await
        if (page) r.pdf.page = page;
      }
      // v0.4.5: a highlight jump is a "take me here" click, not "I kept
      // reading" -- must never overwrite the saved last_page. See the
      // v0.4.5 fix notes.
      this.renderReader(appEl);
      return;
    }
    this.epubStopListenOnJump(r);
    const m = /^spine:(\d+)/.exec(String(h.location_cfi || ''));
    if (m) {
      r.epub.idx = parseInt(m[1], 10);
      r.epub.page = 0;
      this.renderReader(appEl);
      jumpToPageInChapter();
      return;
    }
    if (h.excerpt) {
      const found = await this.locateExcerptInEpub(r, h.excerpt);
      if (this.reader !== r) return; // book was closed/changed mid-await
      if (found) {
        r.epub.idx = found.idx;
        r.epub.page = 0;
        this.renderReader(appEl);
        jumpToPageInChapter();
        return;
      }
    }
    // Nothing resolvable at all (no parseable chapter and no excerpt match)
    // -- re-render rather than silently leaving stale UI state (r.uiPanel
    // was just cleared above), but the reader stays wherever it already
    // was rather than guessing.
    this.renderReader(appEl);
  }

  // renderSidePanel — the one ☰ side panel (v0.3.0), three tabs sharing one
  // shell: Contents (renderTocPanel), Bookmarks (renderBookmarksPanel),
  // Highlights (renderHighlightsPanel). Replaces the old three-separate-
  // panels-behind-three-buttons layout per the approved mockup; 🔍 search
  // stays its own overlay since typing a query is a different kind of
  // interaction from browsing a list.
  renderSidePanel(panelEl, r, appEl) {
    panelEl.empty();
    const tabs = panelEl.createDiv({ cls: 'a4r-sp-tabs' });
    const mkTab = (key, label, tooltip) => {
      const t = tabs.createDiv({ cls: 'a4r-sp-tab', text: label });
      setTooltip(t, tooltip);
      t.toggleClass('a4r-on', r.sidePanelTab === key);
      t.onclick = () => { r.sidePanelTab = key; this.renderReader(appEl); };
      return t;
    };
    mkTab('toc', 'Contents', 'Chapters in this book');
    mkTab('bookmarks', 'Bookmarks', 'Your saved spots in this book');
    mkTab('highlights', 'Highlights', 'Passages you\'ve highlighted');
    mkTab('ask', 'Ask', 'Ask questions about this book'); // v0.10.0, shown to everyone (John, 2026-09-24)
    const bodyEl = panelEl.createDiv({ cls: 'a4r-sp-body' });
    if (r.sidePanelTab === 'ask') this.renderAskPanel(bodyEl, r, appEl);
    else if (r.sidePanelTab === 'bookmarks') this.renderBookmarksPanel(bodyEl, r, appEl);
    else if (r.sidePanelTab === 'highlights') this.renderHighlightsPanel(bodyEl, r, appEl);
    else this.renderTocPanel(bodyEl, r, appEl);
  }

  renderTocPanel(panelEl, r, appEl) {
    const list = panelEl.createDiv({ cls: 'a4r-toc-list' });
    if (r.format === 'pdf') {
      if (r.pdf.outline === undefined) { list.createDiv({ cls: 'a4r-reader-empty', text: 'Loading…' }); return; }
      if (r.pdf.outline && r.pdf.outline.length) {
        for (const item of r.pdf.outline) {
          const row = list.createDiv({ cls: 'a4r-toc-item' });
          if (item.pageNumber === r.pdf.page) row.addClass('a4r-toc-current');
          row.createSpan({ text: item.title });
          row.createSpan({ cls: 'a4r-toc-num', text: String(item.pageNumber) });
          row.onclick = () => { this.beginJump(r, this.currentBook); this.pdfStopListenOnHandTurn(); r.pdf.page = item.pageNumber; this.renderReader(appEl); };
        }
        return;
      }
      // No usable outline in this PDF (common for scanned/simple PDFs) --
      // fall back to a plain page list rather than an empty panel.
      const count = r.pdf.pageCount || 0;
      for (let p = 1; p <= count; p += 1) {
        const row = list.createDiv({ cls: 'a4r-toc-item' });
        if (p === r.pdf.page) row.addClass('a4r-toc-current');
        row.createSpan({ text: `Page ${p}` });
        row.onclick = () => { this.beginJump(r, this.currentBook); this.pdfStopListenOnHandTurn(); r.pdf.page = p; this.renderReader(appEl); };
      }
      return;
    }
    const chapters = r.epub.tocChapters || [];
    if (!chapters.length) { list.createDiv({ cls: 'a4r-reader-empty', text: 'No table of contents in this book.' }); return; }
    chapters.forEach((c, i) => {
      const row = list.createDiv({ cls: 'a4r-toc-item' });
      if (c.idx === r.epub.idx) row.addClass('a4r-toc-current');
      row.createSpan({ text: c.title || '(untitled)' });
      row.createSpan({ cls: 'a4r-toc-num', text: String(i + 1) });
      row.onclick = () => { this.beginJump(r, this.currentBook); this.epubStopListenOnJump(r); r.epub.idx = c.idx; r.epub.page = 0; this.renderReader(appEl); };
    });
  }

  // renderBookmarksPanel — the Bookmarks tab of the unified side panel.
  // `r.bookmarks` is the authoritative in-session list once anything has
  // touched it (set by addBookmark/removeBookmark/updateBookmarkLabel's own
  // return value); only fall back to a fresh metadataCache read the very
  // first time this reader session needs it. Reading straight from
  // `getFm()` on every render was the delete/add race: the frontmatter
  // write and its metadataCache re-parse are not the same event, so a
  // render right after a write could still see the old array (see the
  // v0.2.4 journal entry).
  renderBookmarksPanel(panelEl, r, appEl) {
    if (!Array.isArray(r.bookmarks)) {
      const fm = this.store.getFm(this.currentBook);
      r.bookmarks = Array.isArray(fm.bookmarks) ? fm.bookmarks : [];
    }
    const bookmarks = r.bookmarks;
    if (!bookmarks.length) { panelEl.createDiv({ cls: 'a4r-reader-empty', text: 'No bookmarks yet — use the 🔖 button to bookmark the page you\'re on.' }); return; }
    for (const bm of bookmarks) {
      const row = panelEl.createDiv({ cls: 'a4r-bm-row' });
      const left = row.createDiv();
      // Click-to-rename in place (v0.3.0) — no more "Bookmark added" toast;
      // the toggle button's own default name is already meaningful, and any
      // bookmark can be renamed here, any time, the same Save/Enter/Escape
      // rule every other text field in the Reader uses.
      const labelEl = left.createDiv({ cls: 'a4r-bm-label', text: bm.label || this.describeBookmarkLocation(bm, r) });
      setTooltip(labelEl, 'Click to rename');
      labelEl.onclick = () => { r.editingBookmarkId = r.editingBookmarkId === bm.id ? null : bm.id; this.renderReader(appEl); };
      left.createDiv({ cls: 'a4r-bm-loc', text: this.describeBookmarkLocation(bm, r) });
      const actions = row.createDiv({ cls: 'a4r-bm-actions' });
      const jumpBtn = actions.createEl('button', { cls: 'a4r-icon-btn-sm', text: '→' });
      setTooltip(jumpBtn, 'Jump here');
      jumpBtn.onclick = () => this.jumpToBookmark(bm, r, appEl);
      const delBtn = actions.createEl('button', { cls: 'a4r-icon-btn-sm', text: '🗑' });
      setTooltip(delBtn, 'Delete bookmark');
      delBtn.onclick = async () => {
        r.bookmarks = await this.store.removeBookmark(this.currentBook, bm.id);
        if (r.editingBookmarkId === bm.id) r.editingBookmarkId = null;
        this.renderReader(appEl);
      };
      if (r.editingBookmarkId === bm.id) {
        const renameRow = panelEl.createDiv({ cls: 'a4r-bm-rename-row' });
        const input = renameRow.createEl('input', { type: 'text' });
        input.value = bm.label || '';
        setTooltip(input, 'Rename this bookmark');
        const saveBtn = renameRow.createEl('button', { text: 'Save' });
        setTooltip(saveBtn, 'Save this name');
        const commit = async () => {
          const v = input.value.trim();
          r.bookmarks = await this.store.updateBookmarkLabel(this.currentBook, bm.id, v || null);
          r.editingBookmarkId = null;
          this.renderReader(appEl);
        };
        saveBtn.onclick = commit;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); r.editingBookmarkId = null; this.renderReader(appEl); }
        };
        window.setTimeout(() => { if (input.isConnected) input.focus(); }, 0);
      }
    }
  }

  // renderHighlightsPanel — the Highlights tab of the unified side panel;
  // same book-scoped list Detail already shows, in reading order, but
  // reachable without leaving the Reader. Clicking a card jumps to it.
  renderHighlightsPanel(panelEl, r, appEl) {
    const highlights = this.store.listHighlights(this.currentBook.path).filter((h) => h.status !== 'dismissed');
    if (!highlights.length) { panelEl.createDiv({ cls: 'a4r-reader-empty', text: 'No highlights yet — select text on the page to add one.' }); return; }
    for (const h of highlights) {
      const card = panelEl.createDiv({ cls: 'a4r-hl-mini-card' });
      setTooltip(card, 'Jump here');
      card.createDiv({ cls: 'a4r-hl-mini-excerpt', text: `"${h.excerpt}"` });
      const locParts = [];
      if (h.format === 'pdf') locParts.push(`p.${h.location_page ?? '—'}`);
      else { const loc = this.describeBookmarkLocation({ format: 'epub', location: h.location_cfi }, r); if (loc) locParts.push(loc); }
      if (h.note) locParts.push('📝 has a note');
      card.createDiv({ cls: 'a4r-hl-mini-loc', text: locParts.join(' · ') });
      card.onclick = () => this.jumpToHighlight(h, r, appEl);
    }
  }

  // -------------------- Search --------------------

  renderSearchOverlay(pageWrap, r, appEl) {
    const overlay = pageWrap.createDiv({ cls: 'a4r-search-overlay' });
    const inputRow = overlay.createDiv({ cls: 'a4r-search-input-row' });
    inputRow.createSpan({ text: '🔍' });
    const input = inputRow.createEl('input', { type: 'text', attr: { placeholder: 'Search this book…' } });
    input.value = r.searchQuery || '';
    const countEl = inputRow.createSpan({ cls: 'a4r-search-count' });
    const closeBtn = inputRow.createEl('button', { cls: 'a4r-icon-btn-sm', text: '✕' });
    setTooltip(closeBtn, 'Close search');
    closeBtn.onclick = () => { r.uiPanel = null; this.renderReader(appEl); };
    const resultsEl = overlay.createDiv({ cls: 'a4r-search-results' });

    const renderResults = (results) => {
      resultsEl.empty();
      const capped = results.length >= 500;
      countEl.setText(results.length ? `${results.length}${capped ? '+' : ''} result${results.length === 1 ? '' : 's'}` : (input.value.trim() ? 'No matches' : ''));
      for (const res of results.slice(0, 200)) {
        const row = resultsEl.createDiv({ cls: 'a4r-search-result' });
        const textSpan = row.createSpan();
        textSpan.appendText(res.before);
        textSpan.createEl('b', { text: res.matchText });
        textSpan.appendText(res.after);
        row.createSpan({ cls: 'a4r-search-loc', text: res.locLabel });
        row.onclick = () => this.jumpToSearchResult(res, r, appEl);
      }
    };

    const runSearch = async () => {
      const q = input.value.trim();
      r.searchQuery = input.value;
      if (!q) { renderResults([]); return; }
      countEl.setText('Searching…');
      const results = await this.searchBook(r, q);
      // Stale response guard: a faster later keystroke may have already
      // updated r.searchQuery by the time this await resolves.
      if (input.value.trim() !== q) return;
      renderResults(results);
    };
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.oninput = () => {
      window.clearTimeout(r._searchDebounce);
      r._searchDebounce = window.setTimeout(runSearch, 250);
    };
    input.focus();
    if (r.searchQuery) runSearch();
  }

  // buildEpubSearchIndex — plain text per spine chapter, cached for the rest
  // of this reading session. Cheap: the book's zip buffer is already fully
  // in memory (this.reader.epub.buf) by the time search can be opened, so
  // this is pure parsing, no additional I/O.
  buildEpubSearchIndex(r) {
    if (r.epub.searchIndex) return Promise.resolve(r.epub.searchIndex);
    const out = [];
    for (let i = 0; i < r.epub.spine.length; i += 1) {
      const item = r.epub.spine[i];
      let text = '';
      try {
        const html = readSpineChapter(r.epub.buf, r.epub.entries, item.resolvedPath);
        if (html) {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('script,style').forEach((n) => n.remove());
          text = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
        }
      } catch { /* unreadable chapter -- skip it, don't fail the whole index */ }
      const tocInfo = r.epub.tocChapters && r.epub.tocChapters.length ? findChapterForSpineIdx(r.epub.tocChapters, i) : null;
      out.push({ idx: i, text, chapterNumber: tocInfo ? tocInfo.number : null, title: tocInfo ? tocInfo.title : '' });
    }
    r.epub.searchIndex = out;
    return Promise.resolve(out);
  }

  // buildPdfSearchIndex — one getTextContent() per page (PDF.js), cached.
  // Reuses the already-open r.pdf.doc rather than a second parse. On a very
  // large PDF this can take a few seconds the first time a book's search is
  // opened; there's no progress bar for it beyond the "Searching…" label.
  async buildPdfSearchIndex(r) {
    if (r.pdf.searchIndex) return r.pdf.searchIndex;
    // Search opened before the PDF finished opening (QA fix v0.17.3): wait
    // for it, and never keep an empty index made without the document.
    let doc = r.pdf.doc;
    if (!doc && r.pdf.docPromise) {
      try { doc = (await r.pdf.docPromise).doc; } catch { doc = null; }
    }
    if (!doc) return [];
    const pageCount = doc.numPages || r.pdf.pageCount || 0;
    const out = [];
    for (let p = 1; p <= pageCount; p += 1) {
      try {
        const pg = await doc.getPage(p);
        const tc = await pg.getTextContent();
        out.push({ page: p, text: tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim() });
      } catch { out.push({ page: p, text: '' }); }
    }
    r.pdf.searchIndex = out;
    return out;
  }

  // locateExcerptInEpub / locateExcerptInPdf — best-effort recovery for a
  // highlight whose saved location can't be resolved structurally at all
  // (no page for pdf; an unparseable location_cfi for epub, e.g. a real
  // `epubcfi(...)` string carried over from A3, predating this plugin's
  // own "spine:<n>[:page:<p>:of:<t>]" format entirely). Both search the
  // same per-chapter/per-page plain-text index 🔍 search already builds
  // (cached on the reader state, so a highlight jump right after a search
  // reuses it rather than rebuilding) for the highlight's own saved
  // excerpt text, whitespace-normalized on both sides since the search
  // index text is already normalized this way -- so an old highlight can
  // still land on its real passage instead of silently reopening on the
  // cover (epub) or staying on whatever page the reader was already on
  // (pdf). Not exact -- a short or generic excerpt could in principle
  // match earlier in the book than where it was actually highlighted; the
  // first match wins, same trade-off search results already make.
  async locateExcerptInEpub(r, excerpt) {
    const needle = String(excerpt || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!needle) return null;
    const idx = await this.buildEpubSearchIndex(r);
    for (const entry of idx) {
      if (entry.text.toLowerCase().includes(needle)) return { idx: entry.idx };
    }
    return null;
  }

  async locateExcerptInPdf(r, excerpt) {
    const needle = String(excerpt || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!needle) return null;
    const idx = await this.buildPdfSearchIndex(r);
    for (const entry of idx) {
      if (entry.text.toLowerCase().includes(needle)) return entry.page;
    }
    return null;
  }

  // buildSearchSnippet — trims the before/after context around a match to
  // whole-word boundaries so results never open or close mid-word (e.g.
  // "he Project Gutenberg eBook…"). A wider raw window (SNIPPET_RADIUS) is
  // sliced first so that dropping a partial word at each end still leaves
  // roughly the target-length snippet; an ellipsis is added only on the
  // side actually cut from longer text, never when the snippet starts/ends
  // at the true start/end of the chapter or page text.
  buildSearchSnippet(fullText, matchStart, matchEnd) {
    const RADIUS = 48;
    const beforeStart = Math.max(0, matchStart - RADIUS);
    const afterEnd = Math.min(fullText.length, matchEnd + RADIUS);
    let before = fullText.slice(beforeStart, matchStart);
    let after = fullText.slice(matchEnd, afterEnd);
    const beforeCut = beforeStart > 0;
    const afterCut = afterEnd < fullText.length;
    if (beforeCut) {
      const sp = before.indexOf(' ');
      before = sp === -1 ? '' : before.slice(sp + 1);
    }
    if (afterCut) {
      const sp = after.lastIndexOf(' ');
      after = sp === -1 ? '' : after.slice(0, sp);
    }
    return {
      before: (beforeCut ? '…' : '') + before,
      after: after + (afterCut ? '…' : ''),
    };
  }

  async searchBook(r, query) {
    const q = query.toLowerCase();
    const out = [];
    if (r.format === 'pdf') {
      const idx = await this.buildPdfSearchIndex(r);
      for (const entry of idx) {
        const lower = entry.text.toLowerCase();
        let from = 0;
        while (out.length < 500) {
          const at = lower.indexOf(q, from);
          if (at === -1) break;
          const snippet = this.buildSearchSnippet(entry.text, at, at + q.length);
          out.push({
            format: 'pdf', page: entry.page,
            before: snippet.before, matchText: entry.text.slice(at, at + q.length), after: snippet.after,
            locLabel: `Page ${entry.page}`,
          });
          from = at + q.length;
        }
      }
      return out;
    }
    const idx = await this.buildEpubSearchIndex(r);
    for (const entry of idx) {
      const lower = entry.text.toLowerCase();
      let from = 0;
      while (out.length < 500) {
        const at = lower.indexOf(q, from);
        if (at === -1) break;
        const snippet = this.buildSearchSnippet(entry.text, at, at + q.length);
        out.push({
          format: 'epub', spineIdx: entry.idx, matchStart: at, matchTextFull: entry.text,
          before: snippet.before, matchText: entry.text.slice(at, at + q.length), after: snippet.after,
          locLabel: entry.chapterNumber ? `Ch. ${entry.chapterNumber}` : (entry.title || 'Front matter'),
        });
        from = at + q.length;
      }
    }
    return out;
  }

  computeRangePage(range, columnsHost, r) {
    // Defensive: getClientRects()/getBoundingClientRect() depend on a real
    // layout engine and can throw or return nothing on a detached/invalid
    // range. Fall back to staying on the current page rather than crashing
    // the reader over a best-effort page-precision lookup.
    try {
      const rects = range.getClientRects ? range.getClientRects() : null;
      const rect = (rects && rects.length) ? rects[0] : range.getBoundingClientRect();
      const hostRect = columnsHost.getBoundingClientRect();
      const unit = (r.epub.pageWidth || 1) + (r.epub.pageGap || 0);
      const flowX = rect.left - hostRect.left;
      const total = r.epub.pageCountInChapter || 1;
      return Math.max(0, Math.min(total - 1, Math.floor(flowX / unit)));
    } catch {
      return r.epub.page;
    }
  }

  // jumpToSearchResult — always lands on the right CHAPTER (epub) or PAGE
  // (pdf). For epub, landing on the exact PAGE within that chapter used to
  // be best-effort only: it re-finds the matched snippet in the
  // freshly-rendered chapter DOM and computes its page the same way TTS
  // does, but the search index text is built from `textContent` with
  // whitespace collapsed to single spaces (see buildEpubSearchIndex), so a
  // raw literal line break inside the live DOM's own text nodes (this
  // book's own real chapter markup has one mid-sentence) wouldn't
  // exact-match, silently falling back to the chapter's first page. Now
  // tries findTextRangeFuzzy() (whitespace/curly-quote tolerant, same
  // function drawSavedHighlights/jumpToHighlight already use) after the
  // strict findTextRange() on both the widened and bare match text, so a
  // search match still lands on its real page even across that kind of
  // drift.
  jumpToSearchResult(res, r, appEl) {
    this.beginJump(r, this.currentBook);
    r.uiPanel = null;
    // v0.4.5: a search-result jump is a "take me here" click, not "I kept
    // reading" -- must never overwrite the saved last_page/last_cfi (both
    // branches below no longer call scheduleProgressSave()). See the
    // v0.4.5 fix notes.
    if (res.format === 'pdf') {
      this.pdfStopListenOnHandTurn();
      r.pdf.page = res.page;
      this.renderReader(appEl);
      return;
    }
    this.epubStopListenOnJump(r);
    r.epub.idx = res.spineIdx;
    r.epub.page = 0;
    this.renderReader(appEl);
    const columnsHost = r.epub.columnsHost;
    if (columnsHost) {
      const wide = res.matchTextFull.slice(Math.max(0, res.matchStart - 20), res.matchStart + res.matchText.length + 20).trim();
      const range = this.findTextRange(columnsHost, wide)
        || this.findTextRange(columnsHost, res.matchText)
        || this.findTextRangeFuzzy(columnsHost, wide)
        || this.findTextRangeFuzzy(columnsHost, res.matchText);
      if (range) {
        const target = this.computeRangePage(range, columnsHost, r);
        // Same posture as the Listen feature's own page jump (see
        // rebuildTtsSentences' caller): a full renderReader() re-parses the
        // chapter, simplest way to land the reader's own nav-button state
        // and everything else in sync with the new page.
        if (target !== r.epub.page) { r.epub.page = target; this.renderReader(appEl); }
      }
    }
  }

  // applyTextStylesToPage — the four CSS properties the "Aa" popover
  // controls (font family/size/line-height/padding/text-align), read
  // straight from the global plugin.settings, applied to one already-built
  // `.a4r-reader-page` element. Shared by the page's initial render
  // (renderEpubPage) and every live popover change (applyTextSettings), so
  // the two never drift out of sync with each other. EPUB only -- a PDF
  // page's layout is baked into the file itself.
  applyTextStylesToPage(page, r) {
    if (r.format !== 'epub') return;
    const s = this.plugin.settings;
    page.style.fontFamily = TEXT_FONT_STACKS[s.textFont] || TEXT_FONT_STACKS.serif;
    page.style.fontSize = `${s.textSize}px`;
    page.style.lineHeight = String(s.lineSpacing);
    const margins = Array.isArray(s.textMargins) && s.textMargins.length === 2 ? s.textMargins : [34, 44];
    page.style.padding = `${margins[0]}px ${margins[1]}px`;
    page.style.textAlign = s.justifyText ? 'justify' : 'left';
  }

  // applyTextSettings — the "Aa" popover's live-apply, generalizing the old
  // applyEpubFontSize's own "reflow but keep the same spot" behavior to
  // every control that changes how much text fits on a page (font, size,
  // line spacing, margins) or how a line wraps (justify). Never called for
  // PDF (font-size etc. are wired disabled in the popover for it, and its
  // layout doesn't reflow regardless).
  applyTextSettings(pageWrap, r, appEl) {
    if (r.format !== 'epub') return;
    const page = pageWrap.querySelector('.a4r-reader-page');
    if (!page) return;
    this.applyTextStylesToPage(page, r);
    const viewport = page.querySelector(':scope > .a4r-page-viewport');
    const columnsHost = viewport && viewport.querySelector(':scope > .a4r-page-columns');
    if (!viewport || !columnsHost) return;
    try {
      const priorTotal = r.epub.pageCountInChapter || 1;
      const fraction = priorTotal > 1 && Number.isFinite(r.epub.page) ? r.epub.page / (priorTotal - 1) : 0;
      const newTotal = this.layoutEpubColumns(viewport, columnsHost, r);
      // recomputeSentencePages first -- if Listen is actively on a
      // sentence, land on THAT sentence's real (freshly-measured) page
      // instead of the plain fractional guess, so the spoken/highlighted
      // sentence is never left on a page that isn't the one now shown.
      // Changing a text setting is deliberately never treated as a real
      // reading-progress event beyond this (no jump/"Back to p.N" logic
      // runs here) -- it only re-locates the same saved spot under the
      // new page numbering, the same posture applyEpubFontSize already had.
      this.recomputeSentencePages(columnsHost, r);
      const ttsActive = r.tts && (r.tts.playing || r.tts.paused) ? r.tts.currentIndex : -1;
      const ttsPage = ttsActive >= 0 && r.tts.sentencePages ? r.tts.sentencePages[ttsActive] : null;
      const nextPage = Number.isFinite(ttsPage) ? ttsPage : Math.round(fraction * (newTotal - 1));
      r.epub.page = Math.max(0, Math.min(newTotal - 1, Number.isFinite(nextPage) ? nextPage : 0));
      this.applyEpubPageOffset(columnsHost, r);
      if (r.prevBtn) r.prevBtn.disabled = r.epub.idx <= 0 && r.epub.page <= 0;
      if (r.nextBtn) r.nextBtn.disabled = r.epub.idx >= r.epub.spine.length - 1 && r.epub.page >= newTotal - 1;
      if (r.updateLocPct) r.updateLocPct();
      if (r.updateProgressStrip) r.updateProgressStrip();
      if (r.updateBackToPosChip) r.updateBackToPosChip();
      if (r.updateBookmarkBtn) r.updateBookmarkBtn();
      // drawSavedHighlights()'s <mark> spans and the Listen <span> wrapper
      // both live inside columnsHost's real DOM, which this reflow only
      // re-measures/re-transforms -- never rebuilt from scratch -- so both
      // survive automatically; nothing to redraw here.
      if (ttsActive >= 0 && r.tts.sentenceEls[ttsActive]) this.followScrollToSentence(r.tts.sentenceEls[ttsActive]);
      // After a jump (search result, bookmark, highlight) the saved spot is
      // still the old one and "Back to p. N" is showing: changing the text
      // size isn't reading on, so it must not save the jump as the reader's
      // place (QA fix v0.17.3). Otherwise the re-flowed page is saved.
      if (!r.backToPos && !r._pendingBackToPos) this.scheduleProgressSave();
    } catch (err) {
      console.error('Reading Vault: re-pagination on text-settings change failed', err);
    }
  }

  // applyPageColourLive — Page look (Auto/Dark/Light) needs no reflow at
  // all (it never changes how much text fits), so it's kept separate from
  // applyTextSettings: just the same page.toggleClass/applyReaderPageColors
  // pair the toolbar's old Auto/Dark/Light switch already used, works for
  // both EPUB and PDF pages alike (see readerIsDark/applyReaderPageColors).
  applyPageColourLive(pageWrap, r) {
    const page = pageWrap.querySelector('.a4r-reader-page');
    if (!page) return;
    page.toggleClass('a4r-dark', this.readerIsDark(r));
    this.applyReaderPageColors(page, r);
  }

  // showTextSettingsPopover / dismissTextSettingsPopover / renderTextSettingsBody
  // ("Aa" button, v0.6.0) -- one popover replacing the old A-/A+ pair and
  // Auto/Dark/Light switch, per the approved mockup
  // (mockup-text-settings.html). Nested as a real child of the toolbar's
  // own `.a4r-rt-controls` (same DOM position the mockup uses), NOT
  // appended to document.body the way showVoicePopup()/the highlight-color
  // popup are -- CSS custom properties (--a4r-card etc.) are only ever
  // defined on `.a4r-root` (see renderReader()), so an element appended
  // straight to document.body sits outside that scope and can't see them;
  // .a4r-app/.a4r-reader-toolbar's own overflow:hidden is still escaped by
  // using position:fixed (not absolute) in the CSS, the actual fix the
  // popover-must-be-fixed journal entry found while mocking this up -- a
  // fixed-position element's containing block is the viewport regardless
  // of DOM nesting, so it isn't clipped by an ancestor's overflow either
  // way. (Flagging, not fixing here: the two existing document.body
  // popups may have this same missing-CSS-variable gap live -- every
  // harness/screenshot verifying them so far wrapped the copied markup in
  // its own `.a4r-root` context, which would hide exactly this bug; out of
  // scope for this pass, filed as a Decision.)
  // ==================== FULL SCREEN (v0.15.0) ====================
  // Built to the approved docs/mockups/mockup-full-screen.html. The whole
  // computer screen shows just the book: Obsidian, the tabs and the
  // toolbar hide; moving the mouse to the top brings the toolbar back as a
  // slim bar with "Exit full screen"; Esc exits. Never remembered: every
  // book opens in the normal Reader (John, 2026-09-24).
  enterFullScreen() {
    if (this.fullScreen || this.screen !== 'reader') return;
    const root = this.containerEl.querySelector('.a4r-root');
    const appEl = root && root.querySelector('.a4r-app');
    if (!root || !appEl) return;
    this.dismissTextSettingsPopover();
    this.dismissHighlightPopup({ quiet: true });
    this.fullScreen = true;
    root.addClass('a4r-fs');
    const hint = root.createDiv({ cls: 'a4r-fs-hint', text: 'Move the mouse to the top for controls · Esc to exit' });
    const hintTimer = window.setTimeout(() => hint.remove(), FULL_SCREEN_HINT_MS);

    let hideTimer = null;
    const showTop = () => { window.clearTimeout(hideTimer); root.addClass('a4r-fs-top'); };
    const hideTopSoon = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        // Never while Text settings is open inside the bar.
        if (!this._textSettingsPopover) root.removeClass('a4r-fs-top');
      }, 600);
    };
    const onMove = (e) => {
      if (e.clientY <= FULL_SCREEN_TOP_ZONE) showTop();
      else if (root.hasClass('a4r-fs-top') && !(e.target && e.target.closest && e.target.closest('.a4r-reader-toolbar'))) hideTopSoon();
    };
    const onKey = (e) => {
      // Handled here too: Obsidian's window doesn't always leave full
      // screen on Esc by itself. An open pop-up or panel closes first, and
      // only that (QA fix v0.17.3: this runs before the pop-ups' own Esc
      // handling, so it still sees them open; it used to run after, find
      // them already closed, and leave full screen in the same press).
      if (e.key !== 'Escape') return;
      if (this._textSettingsPopover || document.querySelector('.a4r-hl-color-popup, .a4r-voice-popup')) return;
      e.preventDefault();
      const r = this.reader;
      if (r && r.uiPanel) {
        r.uiPanel = null;
        this.renderReader(this.containerEl.querySelector('.a4r-app'));
        return;
      }
      this.exitFullScreen();
    };
    const onChange = () => {
      // Esc in real full screen is handled by the computer itself; follow it.
      if (this.fullScreen && document.fullscreenElement !== root && this._fsWasReal) this.exitFullScreen();
    };
    root.addEventListener('mousemove', onMove);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onChange);
    this._fsCleanup = () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(hintTimer);
      hint.remove();
      root.removeEventListener('mousemove', onMove);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onChange);
    };
    this._fsWasReal = false;
    if (typeof root.requestFullscreen === 'function') {
      Promise.resolve().then(() => root.requestFullscreen()).then(() => { this._fsWasReal = true; }).catch((err) => {
        // Still useful without it: the book fills Obsidian's pane instead.
        console.warn('Reading Vault: the computer did not allow full screen', err);
      });
    }
    this.renderReader(appEl);
  }

  // rerender: false when the caller is about to redraw (or close) anyway.
  exitFullScreen({ rerender = true } = {}) {
    if (!this.fullScreen) return;
    this.fullScreen = false;
    this._fsWasReal = false;
    if (this._fsCleanup) { this._fsCleanup(); this._fsCleanup = null; }
    this.dismissTextSettingsPopover();
    this.dismissHighlightPopup({ quiet: true });
    const root = this.containerEl.querySelector('.a4r-root');
    if (root) { root.removeClass('a4r-fs'); root.removeClass('a4r-fs-top'); }
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {});
    }
    const appEl = root && root.querySelector('.a4r-app');
    if (rerender && appEl && this.screen === 'reader') this.renderReader(appEl);
  }

  showTextSettingsPopover(btn, r, pageWrap, appEl) {
    this.dismissTextSettingsPopover();
    const controls = btn.parentElement;
    if (!controls) return;
    const popup = controls.createDiv({ cls: 'a4r-textset-popover' });
    this._textSettingsPopover = popup;
    btn.toggleClass('a4r-on', true);
    // v0.14.1 (John's screenshot 2026-09-24): the panel sat too far right
    // and ran off the bottom of the window, under Obsidian's status bar.
    // Obsidian's pane can act as the frame a "fixed" element is placed in,
    // so the panel landed offset by the sidebar's width; placeFixedPopup
    // measures and corrects for that. It is also kept inside the window,
    // and scrolls inside itself when the window is short.
    const reposition = () => {
      if (!popup.isConnected) return;
      const rect = btn.getBoundingClientRect();
      const top = rect.bottom + 6;
      popup.style.maxHeight = `${Math.max(160, window.innerHeight - top - TEXTSET_BOTTOM_ROOM)}px`;
      const left = Math.max(8, Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8));
      placeFixedPopup(popup, top, left);
    };
    this.renderTextSettingsBody(popup, r, pageWrap, appEl, reposition);
    reposition();
    const onOutside = (ev) => {
      if (!popup.contains(ev.target) && ev.target !== btn) this.dismissTextSettingsPopover();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); this.dismissTextSettingsPopover(); } };
    // Repositions on scroll/resize -- the mockup's own build note flagged
    // that its demo only computed position once; capture:true on 'scroll'
    // catches a scroll fired by any nested scrollable container (a real
    // PDF page, a plain-scrolling EPUB fallback, the side panel), not just
    // window-level scrolling, since a captured 'scroll' listener at window
    // sees every scroll event during the capture phase regardless of
    // which element it targets.
    window.setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition, true);
    window.addEventListener('scroll', reposition, true);
    this._textSettingsCleanup = () => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', reposition, true);
      window.removeEventListener('scroll', reposition, true);
    };
  }

  dismissTextSettingsPopover() {
    if (this._textSettingsCleanup) { this._textSettingsCleanup(); this._textSettingsCleanup = null; }
    if (this._textSettingsPopover) {
      const btn = this._textSettingsPopover.parentElement && this._textSettingsPopover.parentElement.querySelector('.a4r-rt-aa-btn');
      this._textSettingsPopover.remove();
      this._textSettingsPopover = null;
      if (btn) btn.toggleClass('a4r-on', false);
    }
  }

  renderTextSettingsBody(popup, r, pageWrap, appEl, reposition) {
    popup.empty();
    const s = this.plugin.settings;
    const isPdf = r.format === 'pdf';
    const refresh = () => { this.renderTextSettingsBody(popup, r, pageWrap, appEl, reposition); reposition(); };

    if (isPdf) {
      const note = popup.createDiv({ cls: 'a4r-ts-section' });
      note.createDiv({ cls: 'a4r-ts-disabled-note', text: "This book is a PDF. Its pages are a fixed picture of the original file's own layout, so font, size, spacing, margins, and justify can't be changed here. Light/Dark still works below." });
    }

    const fontSection = popup.createDiv({ cls: 'a4r-ts-section' });
    fontSection.createDiv({ cls: 'a4r-ts-label', text: 'Font' });
    const fontList = fontSection.createDiv({ cls: 'a4r-ts-fontlist' });
    for (const key of ['serif', 'sans', 'easy', 'theme']) {
      const opt = fontList.createDiv({ cls: `a4r-ts-font-opt${s.textFont === key ? ' a4r-on' : ''}${isPdf ? ' a4r-ts-disabled' : ''}` });
      opt.style.fontFamily = TEXT_FONT_STACKS[key];
      opt.createSpan({ text: TEXT_FONT_LABELS[key] });
      opt.createSpan({ cls: 'a4r-ts-check', text: '✓' });
      if (!isPdf) {
        opt.onclick = async () => {
          s.textFont = key;
          await this.plugin.saveSettings();
          this.applyTextSettings(pageWrap, r, appEl);
          refresh();
        };
      }
    }
    fontSection.createDiv({ cls: 'a4r-ts-caption', text: '"Easy-read" uses Atkinson Hyperlegible, a free font designed for easier reading.' });

    const sizeSection = popup.createDiv({ cls: 'a4r-ts-section' });
    sizeSection.createDiv({ cls: 'a4r-ts-label', text: 'Text size' });
    const sizeRow = sizeSection.createDiv({ cls: 'a4r-ts-size-row' });
    const sizeMinus = sizeRow.createEl('button', { cls: 'a4r-ts-size-btn', text: 'A−' });
    const sizeVal = sizeRow.createSpan({ cls: 'a4r-ts-size-val', text: String(s.textSize) });
    const sizePlus = sizeRow.createEl('button', { cls: 'a4r-ts-size-btn', text: 'A+' });
    setTooltip(sizeMinus, 'Smaller text');
    setTooltip(sizePlus, 'Larger text');
    sizeMinus.disabled = isPdf;
    sizePlus.disabled = isPdf;
    sizeMinus.onclick = async () => {
      s.textSize = Math.max(12, s.textSize - 1);
      await this.plugin.saveSettings();
      sizeVal.setText(String(s.textSize));
      this.applyTextSettings(pageWrap, r, appEl);
    };
    sizePlus.onclick = async () => {
      s.textSize = Math.min(28, s.textSize + 1);
      await this.plugin.saveSettings();
      sizeVal.setText(String(s.textSize));
      this.applyTextSettings(pageWrap, r, appEl);
    };

    const spacingSection = popup.createDiv({ cls: 'a4r-ts-section' });
    spacingSection.createDiv({ cls: 'a4r-ts-label', text: 'Line spacing' });
    const spacingSeg = spacingSection.createDiv({ cls: 'a4r-ts-seg' });
    for (const step of LINE_SPACING_STEPS) {
      const b = spacingSeg.createEl('button', { text: step.label });
      b.toggleClass('a4r-on', Math.abs(s.lineSpacing - step.val) < 0.001);
      b.disabled = isPdf;
      b.onclick = async () => {
        s.lineSpacing = step.val;
        await this.plugin.saveSettings();
        this.applyTextSettings(pageWrap, r, appEl);
        refresh();
      };
    }

    const marginSection = popup.createDiv({ cls: 'a4r-ts-section' });
    marginSection.createDiv({ cls: 'a4r-ts-label', text: 'Margins' });
    const marginSeg = marginSection.createDiv({ cls: 'a4r-ts-seg' });
    for (const step of MARGIN_STEPS) {
      const b = marginSeg.createEl('button', { text: step.label });
      const cur = Array.isArray(s.textMargins) ? s.textMargins : [34, 44];
      b.toggleClass('a4r-on', cur[0] === step.val[0] && cur[1] === step.val[1]);
      b.disabled = isPdf;
      b.onclick = async () => {
        s.textMargins = step.val.slice();
        await this.plugin.saveSettings();
        this.applyTextSettings(pageWrap, r, appEl);
        refresh();
      };
    }

    const justifySection = popup.createDiv({ cls: 'a4r-ts-section' });
    const justifyRow = justifySection.createDiv({ cls: 'a4r-ts-row-flex' });
    justifyRow.createDiv({ cls: 'a4r-ts-label', text: 'Justify text' });
    const justifySwitch = justifyRow.createDiv({ cls: `a4r-ts-switch${s.justifyText ? ' a4r-on' : ''}${isPdf ? ' a4r-ts-disabled' : ''}` });
    justifySection.createDiv({ cls: 'a4r-ts-caption', text: 'Straightens the right edge of each line, like a printed book. Off by default.' });
    if (!isPdf) {
      justifySwitch.onclick = async () => {
        s.justifyText = !s.justifyText;
        await this.plugin.saveSettings();
        this.applyTextSettings(pageWrap, r, appEl);
        refresh();
      };
    }

    const colorSection = popup.createDiv({ cls: 'a4r-ts-section' });
    colorSection.createDiv({ cls: 'a4r-ts-label', text: 'Page look' });
    const colorSeg = colorSection.createDiv({ cls: 'a4r-ts-seg' });
    for (const [key, label] of [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]) {
      const b = colorSeg.createEl('button', { text: label });
      b.toggleClass('a4r-on', r.theme === key);
      // Writes plugin.settings.pageColour too, not just the in-session
      // r.theme -- the OLD toolbar switch only ever set r.theme (only
      // Obsidian's own Settings-tab dropdown wrote the persisted value),
      // so changing Page look here and re-opening a book tomorrow didn't
      // agree. This popover's own control is now the same one source of
      // truth the Settings tab writes.
      b.onclick = async () => {
        r.theme = key;
        s.pageColour = key;
        await this.plugin.saveSettings();
        this.applyPageColourLive(pageWrap, r);
        refresh();
      };
    }
    colorSection.createDiv({ cls: 'a4r-ts-caption', text: 'One place for how the page looks — works for PDF too.' });
  }

  // computeEpubPageMetrics — the actual content box available to the column
  // layout inside `.a4r-reader-page`'s padding (clientWidth/Height include
  // padding, so it has to be subtracted back out for an accurate page size).
  computeEpubPageMetrics(viewport) {
    const cs = getComputedStyle(viewport);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    return {
      width: Math.max(80, Math.floor(viewport.clientWidth - padL - padR)),
      height: Math.max(80, Math.floor(viewport.clientHeight - padT - padB)),
    };
  }

  // epubLivePageCount — the single source of truth for "how many pages does
  // THIS chapter really have right now": re-measures the live, already-laid-
  // out column box (r.epub.columnsHost) instead of trusting the cached
  // r.epub.pageCountInChapter, which a reflow that happens AFTER the last
  // full render (the custom @font-face finishing its swap-in late, a pane
  // resize the ResizeObserver hasn't caught up with yet, or plain float
  // rounding at a column boundary) can leave out of step with the real
  // column count -- exactly the "stuck one page early, no last page, no
  // next chapter" bug (root-caused 2026-09-23: John hit "INTRODUCTION ·
  // p. 41 of 42" and neither → nor the › button could advance). nextBtn now
  // calls this fresh at every click instead of trusting the stale number,
  // so it always reaches the TRUE last page before handing off to the next
  // chapter, whatever produced the drift. Falls back to the cached value
  // only if the DOM isn't there to re-measure (defensive; shouldn't happen
  // from a real click since the chapter is already on screen).
  epubLivePageCount(r) {
    const host = r.epub && r.epub.columnsHost;
    const width = r.epub && r.epub.pageWidth;
    const gap = Number.isFinite(r.epub && r.epub.pageGap) ? r.epub.pageGap : 56;
    if (!host || !host.isConnected || !width) return (r.epub && r.epub.pageCountInChapter) || 1;
    const raw = (host.scrollWidth + gap) / (width + gap);
    // Ceil, not round (the bug in the old layoutEpubColumns formula): a real
    // trailing column with even a sliver of content must count as a whole
    // extra page -- the browser would not have created that column box
    // otherwise. The small epsilon absorbs ordinary subpixel measurement
    // noise right at an exact boundary without ever rounding up past it.
    let n = Math.ceil(raw - 0.01);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (r.epub) r.epub.pageCountInChapter = n; // keep the cached value (page label, etc.) in sync
    return n;
  }

  // layoutEpubColumns — A3's reader (vendored foliate-js) paginates EPUB
  // content with CSS multi-column layout: column-width set to the pane's
  // width so each column is exactly one screen-page, then steps between
  // pages by translating the column container by one column-width(+gap) at
  // a time. Same technique here, without foliate-js's iframe-isolation
  // machinery (not needed -- this reader already parses/sanitizes chapter
  // HTML into a plain div, no untrusted CSS/script survives into it).
  layoutEpubColumns(viewport, columnsHost, r) {
    // Guard against laying out columns against a viewport that doesn't
    // actually have a real size yet -- e.g. right after a plugin
    // reload/Obsidian restart, a leaf can still be hidden (display:none) or
    // not yet attached to the visible workspace the instant renderReader()
    // first runs, in which case clientWidth/clientHeight read 0. Forcing a
    // column-width off a 0-size box would clip the whole chapter to
    // nothing. Fall back to a plain, non-paginated scrollable page instead
    // -- text stays visible -- and let the ResizeObserver re-run
    // layoutEpubColumns() for real once the pane actually has a size.
    if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
      columnsHost.style.columnWidth = '';
      columnsHost.style.columnGap = '';
      columnsHost.style.width = '';
      columnsHost.style.height = '';
      columnsHost.style.transform = '';
      viewport.style.overflowY = 'auto';
      r.epub.pageWidth = 0;
      r.epub.pageGap = 56;
      r.epub.pageCountInChapter = 1;
      return 1;
    }
    viewport.style.overflowY = 'hidden';
    const { width, height } = this.computeEpubPageMetrics(viewport);
    const gap = 56;
    columnsHost.style.columnWidth = `${width}px`;
    columnsHost.style.columnGap = `${gap}px`;
    columnsHost.style.width = `${width}px`;
    columnsHost.style.height = `${height}px`;
    const totalWidth = columnsHost.scrollWidth;
    // Ceil, not round -- see epubLivePageCount()'s comment above for why a
    // trailing column with any real content must always count as a whole
    // extra page rather than risk being rounded away.
    let totalPages = Math.ceil((totalWidth + gap) / (width + gap) - 0.01);
    if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = 1;
    r.epub.pageWidth = width;
    r.epub.pageGap = gap;
    r.epub.pageCountInChapter = totalPages;
    return totalPages;
  }

  applyEpubPageOffset(columnsHost, r) {
    // Never let a bad/NaN state (stale frontmatter, a page index left over
    // from a chapter with a different page count, etc.) produce an invalid
    // transform -- an invalid translateX value is silently dropped by the
    // browser, which would leave the PREVIOUS chapter's offset in place
    // instead of resetting to this chapter's real position.
    const page = Number.isFinite(r.epub.page) ? r.epub.page : 0;
    const width = Number.isFinite(r.epub.pageWidth) ? r.epub.pageWidth : 0;
    const gap = Number.isFinite(r.epub.pageGap) ? r.epub.pageGap : 0;
    if (!width) { columnsHost.style.transform = ''; return; }
    const offset = page * (width + gap);
    columnsHost.style.transform = Number.isFinite(offset) ? `translateX(-${offset}px)` : '';
  }

  // applyReaderPageColors — see A4R_READER_COLORS above: sets page
  // background/text color directly by the reader's OWN Light/Dark toggle,
  // rather than through --a4r-page/--a4r-ink custom properties whose only
  // definitions are keyed to Obsidian's OWN theme.
  readerIsDark(r) {
    if (r.theme === 'auto') return document.body.classList.contains('theme-dark');
    return r.theme === 'dark';
  }

  // Re-colour an open page in place when Obsidian switches light/dark and
  // the page is on Auto -- no re-render, so reading position and a running
  // voice are untouched.
  applyAutoPageColour() {
    const r = this.reader;
    if (!r || r.theme !== 'auto' || this.screen !== 'reader') return;
    this.containerEl.querySelectorAll('.a4r-reader-page').forEach((page) => {
      page.toggleClass('a4r-dark', this.readerIsDark(r));
      this.applyReaderPageColors(page, r);
      if (page.hasClass('a4r-pdf-page')) page.style.background = '#282828'; // the PDF backdrop never changes
    });
  }

  applyReaderPageColors(page, r) {
    const colors = this.readerIsDark(r) ? A4R_READER_COLORS.dark : A4R_READER_COLORS.light;
    page.style.background = colors.page;
    page.style.color = colors.ink;
    // Full screen (v0.15.0): the space around the page takes its colour.
    const root = page.closest('.a4r-root');
    if (root) root.style.setProperty('--a4r-fs-bg', colors.page);
  }

  // renderPdfPage — one PDF page at a time, drawn by Obsidian's bundled
  // PDF.js: a canvas for the look, PDF.js's transparent text layer on top so
  // the reader can select text (and so wireHighlighting works exactly as it
  // does for EPUB), and a highlight layer in between. Laid out to match the
  // old Chromium viewer it replaces: dark backdrop, page fit to the pane's
  // width but never past 100%, centered, 3px/4px margins.
  async renderPdfPage(pageWrap, file, fm, r, appEl) {
    pageWrap.empty();
    if (r.pdf.resizeObserver) { r.pdf.resizeObserver.disconnect(); r.pdf.resizeObserver = null; }
    const page = pageWrap.createDiv({ cls: `a4r-reader-page a4r-pdf-page${this.readerIsDark(r) ? ' a4r-dark' : ''}` });
    this.applyReaderPageColors(page, r);
    page.style.padding = '0';
    page.style.background = '#282828';
    this.wireScrollFollowRelease(page);
    if (!fm.file_path) { page.createDiv({ cls: 'a4r-reader-empty', text: 'No file on this book.' }); return; }
    // A newer render (page turn, resize) supersedes this one mid-await.
    const token = r.pdf.renderToken = (r.pdf.renderToken || 0) + 1;
    const stale = () => token !== r.pdf.renderToken || this.reader !== r || !page.isConnected;
    try {
      if (!r.pdf.doc) {
        page.createDiv({ cls: 'a4r-reader-empty', text: 'Loading…' });
        // One load per book, shared by renders that overlap while it is
        // still loading (QA fix v0.17.2: each used to load its own copy and
        // the first was never closed).
        if (!r.pdf.docPromise) {
          r.pdf.docPromise = (async () => {
            const pdfjsLib = await loadPdfJs();
            const data = new Uint8Array(await this.app.vault.adapter.readBinary(fm.file_path));
            const doc = await pdfjsLib.getDocument({ data, ...PDFJS_DOC_OPTIONS }).promise;
            return { doc, pdfjsLib };
          })();
          r.pdf.docPromise.catch(() => { r.pdf.docPromise = null; }); // a failed load can be tried again
        }
        const { doc, pdfjsLib } = await r.pdf.docPromise;
        if (this.reader !== r) {
          try { if (typeof doc.destroy === 'function') doc.destroy(); } catch { /* already closed */ }
          return;
        }
        if (!r.pdf.doc) {
          r.pdf.doc = doc;
          r.pdf.lib = pdfjsLib;
          this.loadPdfOutline(r, appEl);
        }
      }
      if (stale()) return;
      // The real page count replaces the regex estimate from import time.
      r.pdf.pageCount = r.pdf.doc.numPages;
      // A highlight jump (openHighlightInReader/jumpToHighlight) whose
      // location_page couldn't be resolved sets this -- find the page by
      // the highlight's own excerpt text now that real pages exist,
      // instead of defaulting to page 1.
      if (r.pdf.pendingTextExcerpt) {
        const excerpt = r.pdf.pendingTextExcerpt;
        r.pdf.pendingTextExcerpt = null;
        try {
          const found = await this.locateExcerptInPdf(r, excerpt);
          if (stale()) return;
          if (found) r.pdf.page = found;
        } catch (err) {
          console.error('Reading Vault: could not locate a highlight\'s excerpt in this PDF', err);
        }
      }
      r.pdf.page = Math.max(1, Math.min(r.pdf.pageCount, r.pdf.page || 1));
      if (r.prevBtn) r.prevBtn.disabled = r.pdf.page <= 1;
      if (r.nextBtn) r.nextBtn.disabled = r.pdf.page >= r.pdf.pageCount;
      // v0.5.0: this page number is final for this render (any excerpt-based
      // refinement above has already run) -- the right moment to decide
      // whether a pending jump landed away from the saved position.
      this.resolvePendingBackToPos(r);
      if (r.updateLocPct) r.updateLocPct();
      if (r.updateProgressStrip) r.updateProgressStrip();
      if (r.updateBackToPosChip) r.updateBackToPosChip();

      const pdfPage = await r.pdf.doc.getPage(r.pdf.page);
      if (stale()) return;
      page.empty();
      const renderedWidth = page.clientWidth;
      const base = pdfPage.getViewport({ scale: 1 });
      const maxScale = 96 / 72; // 100% zoom: PDF points to CSS pixels
      const scale = renderedWidth > 8 ? Math.min(maxScale, (renderedWidth - 8) / base.width) : maxScale;
      const viewport = pdfPage.getViewport({ scale });

      const box = page.createDiv({ cls: 'a4r-pdf-box' });
      box.style.width = `${Math.floor(viewport.width)}px`;
      box.style.height = `${Math.floor(viewport.height)}px`;
      box.style.setProperty('--scale-factor', String(scale));
      const canvas = box.createEl('canvas');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      box.createDiv({ cls: 'a4r-pdf-hl-layer' });
      const textDiv = box.createDiv({ cls: 'textLayer' });

      await pdfPage.render({
        canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
      if (stale()) return;
      const textLayer = new r.pdf.lib.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: textDiv, viewport });
      await textLayer.render();
      if (stale()) return;
      // Same trick as Obsidian's/PDF.js's own viewer: an end-of-content
      // block that, while dragging, keeps the selection from jumping to
      // whole-page when the pointer crosses a gap between text runs.
      textDiv.createDiv({ cls: 'endOfContent' });
      textDiv.addEventListener('mousedown', () => {
        textDiv.addClass('selecting');
        document.addEventListener('mouseup', () => textDiv.removeClass('selecting'), { once: true });
      });

      this.wireHighlighting(box, r, appEl);
      this.drawSavedHighlights(box, r);
      this.pdfListenAfterRender(box, r, appEl);

      // Pane resized (sidebar toggle, window resize): redraw at the new fit.
      r.pdf.resizeObserver = new ResizeObserver(() => {
        if (!page.isConnected) return;
        if (Math.abs(page.clientWidth - renderedWidth) < 2) return;
        window.clearTimeout(r.pdf.resizeTimer);
        r.pdf.resizeTimer = window.setTimeout(() => this.renderPdfPage(pageWrap, file, fm, r, appEl), 150);
      });
      r.pdf.resizeObserver.observe(page);
    } catch (err) {
      if (stale()) return;
      console.error('Reading Vault: pdf render failed', err);
      page.empty();
      page.createDiv({ cls: 'a4r-reader-empty', text: 'Could not open this PDF.' });
    }
  }

  // Also frees the EPUB chapter pictures' in-memory copies (see
  // renderEpubPage), since every caller is leaving this book.
  releasePdf(r) {
    if (r && r.epub && r.epub.imageUrls) {
      for (const url of r.epub.imageUrls.values()) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
      r.epub.imageUrls = null;
    }
    if (!r || !r.pdf) return;
    if (r.pdf.resizeObserver) { r.pdf.resizeObserver.disconnect(); r.pdf.resizeObserver = null; }
    window.clearTimeout(r.pdf.resizeTimer);
    r.pdf.renderToken = (r.pdf.renderToken || 0) + 1;
    if (r.pdf.doc) { try { r.pdf.doc.destroy(); } catch { /* already gone */ } r.pdf.doc = null; }
    r.pdf.docPromise = null; // a later render loads it fresh
  }

  // loadPdfOutline — PDF.js's real getOutline() (Obsidian's bundled PDF.js,
  // same loadPdfJs() copy used to render pages), resolved to page numbers.
  // Fire-and-forget from renderPdfPage right after the doc opens; re-renders
  // the Contents panel once done if it's the one open right now. Leaves
  // r.pdf.outline null (not populated) when the PDF has no outline at all --
  // renderTocPanel's own fallback then shows a plain page list, per the
  // approved mockup's caption, rather than the panel disappearing.
  async loadPdfOutline(r, appEl) {
    try {
      const raw = await r.pdf.doc.getOutline();
      if (this.reader !== r) return; // book was closed/changed mid-await
      if (!raw || !raw.length) { r.pdf.outline = null; }
      else {
        const flat = [];
        const walk = async (items) => {
          for (const it of items) {
            let pageNumber = null;
            try {
              let dest = it.dest;
              if (typeof dest === 'string') dest = await r.pdf.doc.getDestination(dest);
              if (Array.isArray(dest) && dest[0] != null) pageNumber = (await r.pdf.doc.getPageIndex(dest[0])) + 1;
            } catch { /* unresolved destination -- skip this entry's page number */ }
            if (pageNumber) flat.push({ title: (it.title || '').trim() || '(untitled)', pageNumber });
            if (it.items && it.items.length) await walk(it.items);
          }
        };
        await walk(raw);
        r.pdf.outline = flat.length ? flat : null;
      }
    } catch (err) {
      console.error('Reading Vault: PDF outline load failed', err);
      if (this.reader === r) r.pdf.outline = null;
    }
    // v0.3.0: Contents lives inside the unified side panel now (r.uiPanel
    // === 'side', with r.sidePanelTab === 'toc' picking the tab) instead of
    // its own 'toc' uiPanel value -- both conditions matter, or a still-
    // open Bookmarks/Highlights tab would get silently swapped back to
    // Contents just because the PDF's outline finished loading in the
    // background.
    if (this.reader === r && r.uiPanel === 'side' && r.sidePanelTab === 'toc' && this.screen === 'reader') {
      this.renderReader(appEl);
    }
  }

  async renderEpubPage(pageWrap, file, fm, r, appEl) {
    pageWrap.empty();
    const page = pageWrap.createDiv({ cls: `a4r-reader-page${this.readerIsDark(r) ? ' a4r-dark' : ''}` });
    this.applyReaderPageColors(page, r);
    this.applyTextStylesToPage(page, r);

    if (!r.epub.loaded) {
      if (!fm.file_path) { page.createDiv({ cls: 'a4r-reader-empty', text: 'No file on this book.' }); return; }
      page.createDiv({ cls: 'a4r-reader-empty', text: 'Loading…' });
      try {
        const ab = await this.app.vault.adapter.readBinary(fm.file_path);
        const buf = Buffer.from(ab);
        const spineInfo = getEpubSpine(buf);
        if (!spineInfo || !spineInfo.spine.length) {
          page.empty();
          page.createDiv({ cls: 'a4r-reader-empty', text: 'Could not read this EPUB\'s chapter list.' });
          return;
        }
        r.epub.buf = buf;
        r.epub.entries = spineInfo.entries;
        r.epub.opfDir = spineInfo.opfDir;
        r.epub.spine = spineInfo.spine;
        r.epub.loaded = true;
        // Real table of contents (nav doc or NCX), so chapter labels/counts
        // match what's actually in the book instead of raw spine-file
        // counting (which includes the cover, title page, copyright, etc.
        // as if they were chapters).
        r.epub.toc = getEpubToc(buf);
        r.epub.tocChapters = buildTocChapterList(r.epub.toc, r.epub.spine);
        // "spine:<idx>" (legacy) or "spine:<idx>:page:<page>:of:<total>"
        // (current -- <total> is the page count measured at whatever pane
        // size/font size was active when it was saved, so it's converted to
        // a fraction here and reapplied against this session's own page
        // count once the chapter is laid out, rather than trusted as-is).
        // A Detail-view Bookmarks-row jump (see openBookmarkFromDetail) wins
        // over the book's normal resume position -- it's a deliberate "take
        // me to this exact spot" click, not a reopen.
        const jumpTarget = r.epub.initialBookmark;
        r.epub.initialBookmark = null;
        const spineMatch = jumpTarget
          ? /^spine:(\d+)(?::page:(\d+):of:(\d+))?$/.exec(String(jumpTarget.location || ''))
          : (typeof fm.last_cfi === 'string' ? /^spine:(\d+)(?::page:(\d+):of:(\d+))?$/.exec(fm.last_cfi) : null);
        if (spineMatch) {
          const idx = parseInt(spineMatch[1], 10);
          if (Number.isFinite(idx) && idx >= 0 && idx < r.epub.spine.length) r.epub.idx = idx;
          if (spineMatch[2] !== undefined && spineMatch[3] !== undefined) {
            const savedPage = parseInt(spineMatch[2], 10);
            const savedTotal = parseInt(spineMatch[3], 10);
            if (savedTotal > 0) r.epub.pendingPageFraction = pageFraction(savedPage, savedTotal);
          }
        } else if (jumpTarget && jumpTarget.excerpt) {
          // A highlight jump whose location_cfi can't be parsed
          // structurally -- e.g. a real `epubcfi(/6/10!/4/2/4,...)` string
          // carried over from A3, predating this plugin's own "spine:<n>"
          // location format entirely (no spine index recorded at all).
          // Find the chapter containing the highlight's own saved excerpt
          // text instead of defaulting to spine index 0 (the cover) --
          // see locateExcerptInEpub().
          const found = await this.locateExcerptInEpub(r, jumpTarget.excerpt);
          if (found) {
            r.epub.idx = found.idx;
          } else if (typeof fm.progress_percent === 'number') {
            // Excerpt text not found either (e.g. it no longer matches the
            // book's raw markup exactly) -- same best-effort percent guess
            // a legacy last_cfi already falls back to below, rather than
            // always reopening on the cover.
            let guess = estimateSpineIdxFromPercent(r.epub.spine, r.epub.entries, fm.progress_percent);
            const firstChapterIdx = r.epub.tocChapters.length ? r.epub.tocChapters[0].idx : null;
            if (firstChapterIdx !== null && guess < firstChapterIdx) guess = firstChapterIdx;
            r.epub.idx = guess;
          }
        } else if (!jumpTarget && typeof fm.progress_percent === 'number') {
          // Unrecognized/legacy last_cfi format (e.g. a real epubcfi carried
          // over from A3) -- best-effort resume via progress_percent instead
          // of always reopening at spine index 0.
          let guess = estimateSpineIdxFromPercent(r.epub.spine, r.epub.entries, fm.progress_percent);
          const firstChapterIdx = r.epub.tocChapters.length ? r.epub.tocChapters[0].idx : null;
          const landsInFrontMatter = firstChapterIdx !== null && guess < firstChapterIdx;
          // Barely-started progress (e.g. this book's 1.4% carried over from
          // A3) is too coarse to trust a byte-weighted guess for -- land on
          // the real first chapter instead, same as a fresh read would.
          if (firstChapterIdx !== null && (fm.progress_percent < 2 || landsInFrontMatter)) guess = firstChapterIdx;
          r.epub.idx = guess;
        }
        // Any highlight jump (structurally resolved above via spineMatch,
        // or text-resolved via locateExcerptInEpub) also tries to land the
        // exact PAGE within the chapter once it renders, not just the
        // chapter -- a bare "spine:6" (no :page: suffix, seen on
        // highlights created before v0.4.1 added page capture) would
        // otherwise land on page 0. Consumed once, further down in
        // renderEpubPage's chapter-render branch.
        if (jumpTarget && jumpTarget.excerpt) {
          r.epub.pendingTextExcerpt = jumpTarget.excerpt;
          r.epub.pendingTextNear = ReadingView.chapterFractionOf(jumpTarget.location);
        }
      } catch (err) {
        console.error('Reading Vault: epub load failed', err);
        page.empty();
        page.createDiv({ cls: 'a4r-reader-empty', text: 'Could not open this EPUB.' });
        return;
      }
      this.renderReader(appEl);
      return;
    }

    // A chapter number from a stale jump or bookmark is kept inside the book.
    if (!Number.isInteger(r.epub.idx) || r.epub.idx < 0) r.epub.idx = 0;
    if (r.epub.spine.length && r.epub.idx >= r.epub.spine.length) { r.epub.idx = r.epub.spine.length - 1; r.epub.page = 0; }
    const spineItem = r.epub.spine[r.epub.idx];
    if (!spineItem) { page.createDiv({ cls: 'a4r-reader-empty', text: 'No chapters found.' }); return; }
    const html = readSpineChapter(r.epub.buf, r.epub.entries, spineItem.resolvedPath);
    if (!html) {
      page.createDiv({ cls: 'a4r-reader-empty', text: 'Could not read this chapter.' });
      // The page buttons still move to the chapter before or after, so an
      // unreadable chapter never traps the reader (QA fix v0.17.3).
      r.epub.columnsHost = null;
      r.epub.pageCountInChapter = 1;
      r.epub.page = 0;
      const autoplay = !!(r.tts && r.tts.pendingAutoplayFromTop) && !r.tts.stopAfterChapter && r.epub.idx < r.epub.spine.length - 1;
      if (r.tts) {
        // Its sentence numbers belong to the chapter before: never saved
        // against this one.
        r.tts.currentIndex = -1;
        if (!autoplay) this.stopPlayback();
      }
      if (autoplay) {
        // Listen was carrying on from the chapter before: skip this one.
        const tts = r.tts;
        window.setTimeout(() => {
          if (this.reader !== r || r.tts !== tts || r.epub.idx >= r.epub.spine.length - 1) return;
          r.epub.idx += 1;
          r.epub.page = 0;
          this.scheduleProgressSave();
          this.renderReader(appEl);
        }, 0);
      } else {
        r.tts = null;
      }
      if (r.prevBtn) {
        r.prevBtn.disabled = r.epub.idx <= 0;
        r.prevBtn.onclick = () => {
          if (r.epub.idx <= 0) return;
          r.epub.idx -= 1; r.epub.page = 'last';
          this.scheduleProgressSave();
          this.renderReader(appEl);
        };
      }
      if (r.nextBtn) {
        r.nextBtn.disabled = r.epub.idx >= r.epub.spine.length - 1;
        r.nextBtn.onclick = () => {
          if (r.epub.idx >= r.epub.spine.length - 1) return;
          r.epub.idx += 1; r.epub.page = 0;
          this.scheduleProgressSave();
          this.renderReader(appEl);
        };
      }
      if (r.updateLocPct) r.updateLocPct();
      if (r.updateProgressStrip) r.updateProgressStrip();
      return;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    sanitizeChapterDoc(doc);
    // Resolve embedded images to blob URLs so the chapter renders with art.
    // Covers two shapes seen in real EPUBs: plain <img src="..."> chapter
    // images, and EPUB cover pages wrapped as <svg><image xlink:href="..."/>
    // (or the SVG2 bare href="...") that a plain img[src] selector never
    // touches -- left unresolved, that raw relative path 404s as Obsidian's
    // generic broken-image placeholder.
    const chapterDir = spineItem.resolvedPath.includes('/') ? spineItem.resolvedPath.slice(0, spineItem.resolvedPath.lastIndexOf('/')) : '.';
    // One picture copy per image for the whole book (QA fix v0.17.3): every
    // page turn re-renders the chapter, and a brand-new copy each time
    // used to load after the page count was measured, so a chapter with
    // large pictures couldn't be paged past them.
    if (!r.epub.imageUrls) r.epub.imageUrls = new Map();
    const resolveEmbeddedImage = (href) => {
      const resolved = posixJoinNormalize(chapterDir, href);
      if (!resolved) return null;
      if (r.epub.imageUrls.has(resolved)) return r.epub.imageUrls.get(resolved);
      const entry = r.epub.entries.get(resolved);
      if (!entry) return null;
      const imgBuf = readZipEntry(r.epub.buf, entry);
      if (!imgBuf) return null;
      const ext = sniffImageExt(imgBuf) || 'png';
      const blob = new Blob([imgBuf], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
      const url = URL.createObjectURL(blob);
      r.epub.imageUrls.set(resolved, url);
      return url;
    };
    doc.querySelectorAll('img[src]').forEach((img) => {
      const url = resolveEmbeddedImage(img.getAttribute('src'));
      if (url) img.setAttribute('src', url);
    });
    doc.querySelectorAll('image').forEach((svgImg) => {
      const href = svgImg.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        || svgImg.getAttribute('xlink:href')
        || svgImg.getAttribute('href');
      if (!href) return;
      const url = resolveEmbeddedImage(href);
      if (!url) return;
      svgImg.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
      svgImg.setAttribute('href', url);
    });
    // Whole-page cover wrapper: <svg viewBox="0 0 W H" width="100%"
    // height="100%"><image .../></svg> (the standard EPUB-cover pattern --
    // confirmed by reading this book's own wrap0000.xhtml directly). This
    // plugin's own CSS constrains a plain <img> to the page correctly
    // (width:auto;height:auto;max-width:100%;max-height:100%), but an
    // inline <svg> does not behave the same way: this CSS's own
    // `width:auto` on the <svg> overrides the element's `width="100%"`
    // presentation attribute (CSS always wins over a presentation
    // attribute), and Chromium then falls back to the raw viewBox pixel
    // size (e.g. 1600x2560) as the SVG's "auto" size -- rendering the cover
    // at native size, far larger than the page, exactly the bug reported.
    // Fix: when an <svg> wraps nothing but a single <image>, replace the
    // whole <svg> with a plain <img> pointing at the same resolved blob URL
    // -- reuses the already-correct, already-tested <img> sizing rule
    // instead of fighting SVG's own percentage/auto sizing quirks. An <svg>
    // with real vector content (paths, text, multiple images) is left
    // exactly as before (href resolved in place, still wrapped in <svg>) --
    // not a shape any real book in this library currently uses on a
    // full-page image, so not chased down further here.
    doc.querySelectorAll('svg').forEach((svg) => {
      const kids = Array.from(svg.children).filter((el) => el.tagName.toLowerCase() !== 'title' && el.tagName.toLowerCase() !== 'desc');
      if (kids.length !== 1 || kids[0].tagName.toLowerCase() !== 'image') return;
      const svgImg = kids[0];
      const url = svgImg.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || svgImg.getAttribute('href');
      if (!url) return;
      const img = doc.createElement('img');
      img.setAttribute('src', url);
      img.setAttribute('alt', '');
      svg.replaceWith(img);
    });
    // Only the book's own images (now blob: links) may load: anything else
    // would reach the internet from inside a book (QA fix v0.17.2).
    dropRemoteImages(doc);

    // Footnote/endnote reference markers (e.g. EPUB3 epub:type="noteref", or
    // Project Gutenberg's <a class="fnanchor pginternal" id="FNanchor_3">f3</a>
    // immediately followed by a second short anchor like "[1.1]") -- tagged
    // here so both the CSS (small, non-wrapping, muted -- see styles.css
    // .a4r-footnote-marker) and rebuildTtsSentences (which excludes this
    // class's text from the chapter's spoken/sentence-split text entirely,
    // see its own TreeWalker filter) treat them the same way everywhere a
    // book might use this pattern, not just this one book. Root-caused
    // 2026-09-23: this book's own real markup abuts a footnote anchor
    // directly against the sentence-ending punctuation with no space
    // ("Buddhahood.”<a ...>f3</a><a ...>[1.1]</a>"), which defeated
    // splitIntoSentences' abbreviation guard (a lowercase letter right after
    // the punctuation, with no intervening whitespace, reads exactly like
    // "e.g.method" and the boundary is rejected) and merged the whole
    // quoted list + footnote markers + the NEXT paragraph into one abnormally
    // long "sentence" whose DOM range crossed an unrelated block (a
    // <div class="poetry-container"> before an ordinary <p> that has no
    // structural relationship to it) -- exactly the shape rebuildTtsSentences'
    // own extractContents() try/catch already anticipates and skips,
    // leaving that entire run of text with no highlight span at all while
    // still being spoken. Excluding the marker text from the walk removes
    // the no-space abutment, so the real sentence boundary right after
    // "Buddhahood.”" is found normally again.
    doc.querySelectorAll('a').forEach((a) => {
      if (isFootnoteMarkerAnchor(a)) a.classList.add('a4r-footnote-marker');
    });

    // Chapter label for the Listen bar (e.g. "Chapter 4 of 16 · Introduction")
    // -- from the book's own real table of contents when it has one, so "N
    // of M" matches how the reader actually thinks of the book's chapters
    // rather than counting raw spine files (cover/title/copyright page
    // included). Falls back to the chapter's own first heading + a bare
    // spine position only for a book with no usable TOC, or for a page
    // (front matter) that comes before the TOC's first listed chapter.
    const tocInfo = r.epub.tocChapters && r.epub.tocChapters.length
      ? findChapterForSpineIdx(r.epub.tocChapters, r.epub.idx) : null;
    let chapterLabel;
    if (tocInfo) {
      chapterLabel = tocInfo.title || '';
    } else {
      const headingEl = doc.querySelector('h1,h2,h3');
      const headingText = headingEl ? headingEl.textContent.trim().replace(/\s+/g, ' ') : '';
      chapterLabel = headingText || '';
    }

    page.empty();
    // Pagination: a fixed-size, overflow:hidden viewport holding a CSS
    // multi-column content box (column-width == viewport width, so each
    // column is exactly one screen-page); "turning a page" translates the
    // column box left/right by one column-width(+gap). See
    // layoutEpubColumns()/applyEpubPageOffset() below.
    const viewport = page.createDiv({ cls: 'a4r-page-viewport' });
    this.wireScrollFollowRelease(viewport);
    const columnsHost = viewport.createDiv({ cls: 'a4r-page-columns' });
    r.epub.columnsHost = columnsHost;
    while (doc.body.firstChild) columnsHost.appendChild(doc.body.firstChild);
    // Links inside the book (QA fix v0.17.2): never let the window follow
    // one. A link to another chapter jumps there; a web link opens in the
    // browser; a link within this chapter stays put.
    columnsHost.addEventListener('click', (e) => {
      // Any <a>, with or without an address (QA fix v0.17.3: an SVG link
      // could get its address later, so every link click is caught here).
      const a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a || !columnsHost.contains(a)) return;
      e.preventDefault();
      const href = a.getAttribute('href') || a.getAttribute('xlink:href') || '';
      if (/^https?:\/\//i.test(href)) { window.open(href); return; }
      const hash = href.indexOf('#');
      const pathPart = hash >= 0 ? href.slice(0, hash) : href;
      let anchor = hash >= 0 ? href.slice(hash + 1) : '';
      try { anchor = decodeURIComponent(anchor); } catch { /* keep as written */ }
      const idx = pathPart
        ? r.epub.spine.findIndex((sp) => sp.resolvedPath === posixJoinNormalize(chapterDir, pathPart)) // decodes %20 etc.
        : r.epub.idx;
      if (idx < 0) return;
      // A link to a spot (a footnote, say) goes to that spot's page, not
      // the start of its chapter (QA fix v0.17.3).
      if (idx === r.epub.idx) {
        const el = anchor ? this.findAnchorElement(columnsHost, anchor) : null;
        if (!el || !r.epub.pageWidth || this.computePageForElement(el, columnsHost, r) === r.epub.page) return;
      } else {
        this.epubStopListenOnJump(r);
        r.epub.idx = idx;
        r.epub.page = 0;
      }
      this.beginJump(r, this.currentBook);
      r.epub.pendingAnchor = anchor || null;
      this.renderReader(appEl);
    });
    this.wireHighlighting(columnsHost, r, appEl);
    this.drawSavedHighlights(columnsHost, r);

    // Pagination is wrapped defensively: text is already in the DOM at this
    // point (appended above), so if anything below throws or measures
    // garbage, fall back to a plain scrollable page rather than leaving the
    // pane looking empty -- a working, unpaginated reader beats a broken,
    // blank one.
    let totalPages = 1;
    // The page asked for before it was fitted to the measured page count;
    // 'last' stays 'last', so a picture that loads later still lands there.
    const askedLast = r.epub.page === 'last';
    let wantedPage = null;
    try {
      trimChapterTopGap(columnsHost);
      totalPages = this.layoutEpubColumns(viewport, columnsHost, r);
      if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = 1;
      if (r.epub.page === 'last') {
        r.epub.page = totalPages - 1;
      } else if (typeof r.epub.pendingPageFraction === 'number' && Number.isFinite(r.epub.pendingPageFraction)) {
        r.epub.page = Math.round(r.epub.pendingPageFraction * (totalPages - 1));
        r.epub.pendingPageFraction = null;
      }
      if (!Number.isFinite(r.epub.page)) r.epub.page = 0;
      wantedPage = r.epub.page;
      r.epub.page = Math.max(0, Math.min(totalPages - 1, r.epub.page));
      this.applyEpubPageOffset(columnsHost, r);
    } catch (err) {
      console.error('Reading Vault: pagination failed, showing this chapter as a plain scrolling page instead', err);
      columnsHost.style.columnWidth = '';
      columnsHost.style.columnGap = '';
      columnsHost.style.width = '';
      columnsHost.style.height = '';
      columnsHost.style.transform = '';
      viewport.style.overflowY = 'auto';
      r.epub.page = 0;
      r.epub.pageWidth = 0;
      r.epub.pageCountInChapter = 1;
      totalPages = 1;
    }
    if (window.speechSynthesis) {
      try {
        this.rebuildTtsSentences(columnsHost, r, appEl, chapterLabel);
        // Wrapping every sentence in its own inline <span> reflows the
        // chapter (measured on "Essays in Zen Buddhism"'s Introduction at
        // 1312x416: 36880px of column flow before wrapping, 43720px after --
        // 27 pages vs 32). The page count measured above is therefore stale
        // the moment the Listen spans go in: without this re-measure the
        // last several pages of every chapter are unreachable, because the
        // next button hands off to the following chapter at the old,
        // too-small total. Re-measure, re-clamp, and recompute which page
        // each sentence now lands on.
        if (r.epub.pageWidth) {
          const remeasured = this.layoutEpubColumns(viewport, columnsHost, r);
          if (Number.isFinite(remeasured) && remeasured >= 1) {
            totalPages = remeasured;
            r.epub.page = Math.max(0, Math.min(totalPages - 1, Number.isFinite(r.epub.page) ? r.epub.page : 0));
            this.applyEpubPageOffset(columnsHost, r);
            this.recomputeSentencePages(columnsHost, r);
          }
        }
      } catch (err) {
        console.error('Reading Vault: Listen sentence-splitting failed for this chapter', err);
      }
    }

    // A highlight jump (openHighlightInReader / jumpToHighlight) that set
    // pendingTextExcerpt tries to land the exact PAGE within this
    // now-rendered chapter, not just the chapter -- same
    // findTextRange(columnsHost, h.excerpt) + computeRangePage pair
    // jumpToHighlight()/jumpToSearchResult() already use for this. The raw,
    // unnormalized excerpt is tried first (exact match against the DOM's
    // real text, the already-proven approach); a whitespace-normalized
    // version is tried only as a fallback, since a highlight note's saved
    // excerpt can very rarely differ from raw DOM text by exactly a
    // whitespace run (e.g. a soft line break inside the original
    // selection). Consumed once (cleared immediately) so a later page turn
    // within the same chapter doesn't keep snapping back to the highlight.
    if (r.epub.pendingTextExcerpt) {
      const excerpt = r.epub.pendingTextExcerpt;
      r.epub.pendingTextExcerpt = null;
      try {
        const normalized = excerpt.replace(/\s+/g, ' ').trim();
        const near = Number.isFinite(r.epub.pendingTextNear) ? r.epub.pendingTextNear : null;
        r.epub.pendingTextNear = null;
        const range = this.findTextRange(columnsHost, excerpt, near)
          || (normalized !== excerpt ? this.findTextRange(columnsHost, normalized, near) : null)
          || this.findTextRangeFuzzy(columnsHost, excerpt);
        if (range) {
          const target = this.computeRangePage(range, columnsHost, r);
          if (Number.isFinite(target) && target !== r.epub.page) {
            r.epub.page = target;
            this.applyEpubPageOffset(columnsHost, r);
          }
        }
      } catch (err) {
        console.error('Reading Vault: could not refine a highlight jump to its exact page', err);
      }
    }

    // A link into this chapter at a named spot (see the link clicks above).
    if (r.epub.pendingAnchor) {
      const anchor = r.epub.pendingAnchor;
      r.epub.pendingAnchor = null;
      const el = r.epub.pageWidth ? this.findAnchorElement(columnsHost, anchor) : null;
      if (el) {
        r.epub.page = this.computePageForElement(el, columnsHost, r);
        this.applyEpubPageOffset(columnsHost, r);
      }
    }

    const updateNavButtons = (total) => {
      if (r.prevBtn) r.prevBtn.disabled = r.epub.idx <= 0 && r.epub.page <= 0;
      if (r.nextBtn) r.nextBtn.disabled = r.epub.idx >= r.epub.spine.length - 1 && r.epub.page >= total - 1;
    };
    updateNavButtons(totalPages);
    // A picture still loading has no size yet, so the chapter was measured
    // short. Measure again as each one arrives and go to the page that was
    // asked for, if it now exists (QA fix v0.17.3).
    const pendingImages = Array.from(columnsHost.querySelectorAll('img, image')).filter((el) => !(el.tagName === 'IMG' && el.complete));
    if (pendingImages.length && r.epub.pageWidth) {
      let expected = r.epub.page;
      const relayout = () => {
        if (!columnsHost.isConnected || this.reader !== r || r.epub.columnsHost !== columnsHost) return;
        try {
          const newTotal = this.layoutEpubColumns(viewport, columnsHost, r);
          let target = r.epub.page;
          // Only while the reader hasn't turned the page since.
          if (r.epub.page === expected) {
            if (askedLast) target = newTotal - 1;
            else if (Number.isFinite(wantedPage)) target = wantedPage;
          }
          r.epub.page = Math.max(0, Math.min(newTotal - 1, target));
          expected = r.epub.page;
          this.applyEpubPageOffset(columnsHost, r);
          updateNavButtons(newTotal);
          this.recomputeSentencePages(columnsHost, r);
          if (r.updateLocPct) r.updateLocPct();
          if (r.updateProgressStrip) r.updateProgressStrip();
        } catch (err) {
          console.error('Reading Vault: re-measuring a chapter after a picture loaded failed', err);
        }
      };
      pendingImages.forEach((el) => el.addEventListener('load', relayout, { once: true }));
    }
    // v0.5.0: r.epub.idx/page are final for this render (pendingPageFraction/
    // pendingTextExcerpt refinement above has already run) -- the right
    // moment to decide whether a pending jump landed away from the saved
    // position.
    this.resolvePendingBackToPos(r);
    if (r.updateLocPct) r.updateLocPct();
    if (r.updateProgressStrip) r.updateProgressStrip();
    if (r.updateBackToPosChip) r.updateBackToPosChip();

    if (r.prevBtn) {
      r.prevBtn.onclick = () => {
        if (r.epub.page > 0) r.epub.page -= 1;
        else if (r.epub.idx > 0) { this.stopListenForHandChapterTurn(r); r.epub.idx -= 1; r.epub.page = 'last'; }
        else return;
        this.plugin.sessionRecorder.notePageTurn(this.bookInfo(), 'read');
        this.scheduleProgressSave();
        this.renderReader(appEl);
      };
    }
    if (r.nextBtn) {
      r.nextBtn.onclick = () => {
        // Re-measure the live column box rather than trusting the cached
        // r.epub.pageCountInChapter (see epubLivePageCount() above) -- this
        // is the fix for "stuck one page early, no last page, no next
        // chapter": whatever left the cached count out of step with the
        // real columns, the click always checks against the true DOM.
        const liveTotal = this.epubLivePageCount(r);
        if (r.epub.page < liveTotal - 1) r.epub.page += 1;
        else if (r.epub.idx < r.epub.spine.length - 1) { this.stopListenForHandChapterTurn(r); r.epub.idx += 1; r.epub.page = 0; }
        else return;
        this.plugin.sessionRecorder.notePageTurn(this.bookInfo(), 'read');
        this.scheduleProgressSave();
        this.renderReader(appEl);
      };
    }

    // Recompute pagination when the pane itself resizes (window resize,
    // sidebar toggle, etc.), keeping the reader at the same relative spot
    // in the chapter rather than snapping back to page 1.
    if (r.epub.resizeObserver) r.epub.resizeObserver.disconnect();
    r.epub.resizeObserver = new ResizeObserver(() => {
      if (!columnsHost.isConnected) return;
      try {
        const priorTotal = r.epub.pageCountInChapter || 1;
        const fraction = priorTotal > 1 && Number.isFinite(r.epub.page) ? r.epub.page / (priorTotal - 1) : 0;
        const newTotal = this.layoutEpubColumns(viewport, columnsHost, r);
        const nextPage = Math.round(fraction * (newTotal - 1));
        r.epub.page = Math.max(0, Math.min(newTotal - 1, Number.isFinite(nextPage) ? nextPage : 0));
        this.applyEpubPageOffset(columnsHost, r);
        updateNavButtons(newTotal);
        if (r.updateLocPct) r.updateLocPct();
        if (r.updateProgressStrip) r.updateProgressStrip();
        if (r.updateBackToPosChip) r.updateBackToPosChip();
        if (r.updateBookmarkBtn) r.updateBookmarkBtn();
        this.recomputeSentencePages(columnsHost, r);
      } catch (err) {
        console.error('Reading Vault: re-pagination on resize failed', err);
      }
    });
    r.epub.resizeObserver.observe(viewport);
  }

  // recomputeSentencePages — after a resize/font-size reflow the chapter's
  // sentence <span> wrapping is still valid (no text changed), only which
  // page each one now falls on. Cheaper than a full rebuildTtsSentences().
  recomputeSentencePages(columnsHost, r) {
    if (!r.tts || !r.tts.sentenceEls) return;
    r.tts.sentencePages = r.tts.sentenceEls.map((el) => (el ? this.computePageForElement(el, columnsHost, r) : r.epub.page));
  }

  // Wraps [start,end) of the text content under `root` (raw, unnormalized —
  // this must match what sel.toString().trim() produced at creation time) in
  // a <mark>. Uses extractContents/insertNode rather than surroundContents so
  // a match spanning multiple elements (bold/italic runs, etc.) still wraps
  // correctly instead of throwing.
  // `near` (0 to 1, optional): where in the chapter the words were saved.
  // When the same words appear more than once, the copy closest to that
  // spot is used, not simply the first (QA fix v0.17.3).
  findTextRange(root, target, near = null) {
    if (!target) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = '';
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: full.length, end: full.length + node.nodeValue.length });
      full += node.nodeValue;
    }
    let idx = full.indexOf(target);
    if (idx === -1) return null;
    if (Number.isFinite(near) && full.length) {
      const want = near * full.length;
      for (let k = full.indexOf(target, idx + 1); k !== -1; k = full.indexOf(target, k + 1)) {
        if (Math.abs(k + target.length / 2 - want) < Math.abs(idx + target.length / 2 - want)) idx = k;
      }
    }
    const endIdx = idx + target.length;
    const startInfo = nodes.find((x) => idx >= x.start && idx < x.end);
    const endInfo = [...nodes].reverse().find((x) => endIdx > x.start && endIdx <= x.end);
    if (!startInfo || !endInfo) return null;
    const range = document.createRange();
    range.setStart(startInfo.node, idx - startInfo.start);
    range.setEnd(endInfo.node, endIdx - endInfo.start);
    return range;
  }

  // findTextRangeFuzzy — like findTextRange, but tolerant of the two real
  // divergences confirmed (via this book's own actual chapter markup and
  // its own actual saved highlight excerpts) between a highlight's saved
  // excerpt and the book's raw source text: a whitespace run (e.g. the raw
  // XHTML has a literal newline -- "sorrow,\nyou" -- where the excerpt has
  // a plain space) and curly vs. straight quote/dash characters. Used only
  // for a highlight jump's best-effort exact-page refine (see
  // pendingTextExcerpt in renderEpubPage and jumpToHighlight above), where
  // landing on the chapter's first page instead of the highlighted
  // paragraph is a real, felt miss -- unlike drawSavedHighlights/
  // jumpToSearchResult (unchanged, out of scope this pass, flagged as a
  // related gap in Decisions), which use the strict findTextRange above
  // and simply skip drawing a highlight's on-page <mark> rather than risk
  // marking the wrong words. Normalizes both the DOM's real text and the
  // target the same way, but keeps a raw-offset map alongside the
  // normalized string so the returned Range still points at the actual
  // (unnormalized) text nodes.
  findTextRangeFuzzy(root, target) {
    if (!target) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = '';
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: full.length, end: full.length + node.nodeValue.length });
      full += node.nodeValue;
    }
    const normalizeChar = (ch) => {
      if (/[‘’‚‛]/.test(ch)) return "'";
      if (/[“”„‟]/.test(ch)) return '"';
      if (/[–—]/.test(ch)) return '-';
      return ch;
    };
    let normFull = '';
    const map = []; // map[i] = raw offset in `full` of normFull[i]
    let inWs = false;
    for (let i = 0; i < full.length; i += 1) {
      const ch = full[i];
      if (/\s/.test(ch)) {
        if (!inWs) { normFull += ' '; map.push(i); inWs = true; }
        continue;
      }
      inWs = false;
      normFull += normalizeChar(ch);
      map.push(i);
    }
    let normTarget = '';
    let prevWasWs = false;
    for (const ch of String(target)) {
      if (/\s/.test(ch)) {
        if (!prevWasWs) normTarget += ' ';
        prevWasWs = true;
        continue;
      }
      prevWasWs = false;
      normTarget += normalizeChar(ch);
    }
    normTarget = normTarget.trim();
    if (!normTarget) return null;
    const at = normFull.indexOf(normTarget);
    if (at === -1) return null;
    const rawStart = map[at];
    const lastNormIdx = at + normTarget.length - 1;
    const rawEnd = lastNormIdx < map.length ? map[lastNormIdx] + 1 : full.length;
    const startInfo = nodes.find((x) => rawStart >= x.start && rawStart < x.end);
    const endInfo = [...nodes].reverse().find((x) => rawEnd > x.start && rawEnd <= x.end);
    if (!startInfo || !endInfo) return null;
    const range = document.createRange();
    range.setStart(startInfo.node, rawStart - startInfo.start);
    range.setEnd(endInfo.node, rawEnd - endInfo.start);
    return range;
  }

  wrapRangeInMark(range, color, hlFile) {
    const mark = document.createElement('mark');
    if (color) mark.style.background = color;
    if (hlFile) mark.dataset.a4rHighlightPath = hlFile.path;
    const frag = range.extractContents();
    mark.appendChild(frag);
    range.insertNode(mark);
    return mark;
  }

  // Where in its chapter a saved "spine:i:page:p:of:t" spot is, 0 to 1
  // (the middle of that page), or null when no page was saved.
  static chapterFractionOf(location) {
    const m = /^spine:\d+:page:(\d+):of:(\d+)$/.exec(String(location || ''));
    if (!m) return null;
    const page = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    return total > 0 ? Math.min(1, (page + 0.5) / total) : null;
  }

  // Redraws this chapter's already-saved highlights as <mark> elements so
  // they're visible and clickable on reopen, not just at the moment they're
  // created. PDF pages hand off to drawSavedPdfHighlights (overlay marks).
  //
  // Two real gaps fixed here (v0.4.4), confirmed against this book's own
  // real 4 highlight records: (1) `location_cfi` gated on exact string
  // equality against `spine:<idx>` -- broken the moment a highlight's own
  // location carries a page suffix too (`spine:<idx>:page:<p>:of:<t>`, the
  // v0.4.1 EPUB page-capture fix), which never equals the bare
  // `spine:<idx>` this function built to compare against. Now parses just
  // the spine index out of whatever's stored and gates on that. (2) A
  // location_cfi predating this plugin's own format entirely (a real
  // `epubcfi(...)` string carried over from A3) has no spine index to
  // parse at all, so it never matched any chapter and never even attempted
  // to draw -- there's no async excerpt-search here (unlike
  // locateExcerptInEpub) to resolve which chapter it belongs to, so an
  // unparseable location instead falls through and lets the text match
  // below decide: findTextRange/Fuzzy only ever finds text that's actually
  // in *this* chapter's own DOM, so it can't accidentally draw on the
  // wrong page. Also uses findTextRangeFuzzy() as a fallback after the
  // strict findTextRange(), same as jumpToHighlight's own page-precision
  // step, since this book's own real excerpts don't always exact-match the
  // book's raw chapter markup (curly quotes, literal mid-sentence
  // newlines) -- previously flagged as a known gap in Decisions, now
  // closed for this function.
  drawSavedHighlights(contentHost, r) {
    if (r.format === 'pdf') { this.drawSavedPdfHighlights(contentHost, r); return; }
    if (r.format !== 'epub') return;
    const all = this.store.listHighlights(this.currentBook.path);
    for (const h of all) {
      if (h.status === 'dismissed') continue;
      const m = /^spine:(\d+)/.exec(String(h.location_cfi || ''));
      if (m && parseInt(m[1], 10) !== r.epub.idx) continue;
      const excerpt = String(h.excerpt || '').trim();
      if (!excerpt) continue;
      const range = this.findTextRange(contentHost, excerpt, ReadingView.chapterFractionOf(h.location_cfi)) || this.findTextRangeFuzzy(contentHost, excerpt);
      if (!range) continue; // no exact or fuzzy match in this chapter; skip rather than crash
      const mark = this.wrapRangeInMark(range, h.color, h.file);
      if (mark && h.note) mark.addClass('a4r-has-note');
    }
  }

  // PDF counterpart of drawSavedHighlights: this page's saved highlights,
  // found by their excerpt in the page's text layer. PDF marks are an
  // absolutely-positioned overlay behind the real text (see drawPdfMark),
  // not a <mark> wrapping real text, so there's no on-page 📝 glyph here --
  // the note itself still round-trips through the same highlight popup.
  drawSavedPdfHighlights(box, r) {
    const textDiv = box.querySelector(':scope > .textLayer');
    if (!textDiv) return;
    for (const h of this.store.listHighlights(this.currentBook.path)) {
      if (h.status === 'dismissed') continue;
      const range = this.pdfRangeForHighlight(box, textDiv, String(h.excerpt || '').trim(), Number(h.location_page), r.pdf.page);
      if (!range) continue; // no match on this page's text; skip rather than crash
      this.drawPdfMark(box, range, h.color, h.file, h.note ? 'a4r-has-note' : undefined);
    }
  }

  // Where a saved PDF highlight sits on `page`. A highlight is saved on the
  // page it starts on; one made from a Listen sentence can run from the
  // bottom of that page onto the top of the next, so on its own page we
  // also accept just its opening words (if they end the page's text) and
  // on the following page its closing words (if they open the page's text).
  pdfRangeForHighlight(box, textDiv, excerpt, locationPage, page) {
    if (!excerpt) return null;
    if (locationPage === page) return this.findPdfTextRange(textDiv, excerpt) || this.findPdfSplitRange(box, textDiv, excerpt, 'head');
    if (locationPage === page - 1) return this.findPdfSplitRange(box, textDiv, excerpt, 'tail');
    return null;
  }

  // The part of a page-spanning excerpt on this page: 'head' = the longest
  // opening of the excerpt found here, with nothing after it but running
  // header/footer text (top or bottom 12% of the page -- PDFs often put the
  // page number first or last in text order regardless of where it sits);
  // 'tail' = the longest ending found here, with only header/footer text
  // before it. Those checks keep an ordinary highlight's words from
  // matching somewhere they aren't.
  findPdfSplitRange(box, textDiv, excerpt, part) {
    const want = excerpt.replace(/\s+/g, '');
    if (want.length < 16) return null;
    const walker = document.createTreeWalker(textDiv, NodeFilter.SHOW_TEXT);
    const owners = []; // per non-space character: the element it sits in
    let full = '';
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) continue;
        full += v[i];
        owners.push(node.parentElement);
      }
    }
    const find = (k) => (part === 'head' ? full.lastIndexOf(want.slice(0, k)) : full.indexOf(want.slice(want.length - k)));
    // Longest k that still occurs (occurrence only gets rarer as k grows).
    let lo = 8;
    let hi = want.length - 1;
    if (find(lo) === -1) return null;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (find(mid) !== -1) lo = mid; else hi = mid - 1;
    }
    const at = find(lo);
    const boxRect = box.getBoundingClientRect();
    const h = boxRect.height || 1;
    const rectCache = new Map();
    const inBand = (el) => {
      if (!rectCache.has(el)) rectCache.set(el, el.getBoundingClientRect());
      const b = rectCache.get(el);
      return b.top - boxRect.top >= h * 0.88 || b.bottom - boxRect.top <= h * 0.12;
    };
    const others = part === 'head' ? owners.slice(at + lo) : owners.slice(0, at);
    if (!others.every(inBand)) return null;
    return this.pdfNwRange(textDiv, at, at + lo - 1);
  }

  // Like findTextRange, but ignores whitespace on both sides: PDF.js splits
  // a page into positioned text runs, so the spaces/line breaks between
  // words in the saved excerpt don't reliably exist as text nodes.
  findPdfTextRange(root, target) {
    const want = String(target || '').replace(/\s+/g, '');
    if (!want) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const map = []; // one entry per non-whitespace character: [node, offset]
    let full = '';
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) continue;
        full += v[i];
        map.push([node, i]);
      }
    }
    const idx = full.indexOf(want);
    if (idx === -1) return null;
    const [startNode, startOff] = map[idx];
    const [endNode, endOff] = map[idx + want.length - 1];
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff + 1);
    return range;
  }

  // A PDF highlight is a <mark> spanning the passage's bounding box, holding
  // one colored block per line of the selection. Drawn as an overlay (not
  // by wrapping the text, as EPUB does) because PDF.js text runs are
  // absolutely positioned and would lose their placement if split up.
  drawPdfMark(box, range, color, hlFile, cls) {
    const layer = box.querySelector(':scope > .a4r-pdf-hl-layer');
    if (!layer) return null;
    const origin = box.getBoundingClientRect();
    const rects = [];
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      const rect = { left: cr.left - origin.left, top: cr.top - origin.top, width: cr.width, height: cr.height };
      // Nested text-layer elements report the same area twice; keep one.
      if (rects.some((o) => rect.left >= o.left - 1 && rect.top >= o.top - 1
        && rect.left + rect.width <= o.left + o.width + 1 && rect.top + rect.height <= o.top + o.height + 1)) continue;
      rects.push(rect);
    }
    if (!rects.length) return null;
    const minL = Math.min(...rects.map((o) => o.left));
    const minT = Math.min(...rects.map((o) => o.top));
    const maxR = Math.max(...rects.map((o) => o.left + o.width));
    const maxB = Math.max(...rects.map((o) => o.top + o.height));
    const mark = layer.createEl('mark', cls ? { cls } : undefined);
    if (hlFile) mark.dataset.a4rHighlightPath = hlFile.path;
    Object.assign(mark.style, { left: `${minL}px`, top: `${minT}px`, width: `${maxR - minL}px`, height: `${maxB - minT}px` });
    for (const o of rects) {
      const part = mark.createDiv({ cls: 'a4r-pdf-hl-part' });
      Object.assign(part.style, { left: `${o.left - minL}px`, top: `${o.top - minT}px`, width: `${o.width}px`, height: `${o.height}px` });
      if (color) part.style.background = color;
    }
    return mark;
  }

  // Which PDF highlight (if any) is under a click point -- only for a plain
  // click, not the mouseup that ends a new selection.
  pdfMarkAt(box, x, y) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return null;
    for (const mark of Array.from(box.querySelectorAll('.a4r-pdf-hl-layer > mark[data-a4r-highlight-path]'))) {
      for (const part of Array.from(mark.children)) {
        const b = part.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return mark;
      }
    }
    return null;
  }

  // ==================== LISTEN (read-aloud) ====================
  // Uses the Web Speech API (window.speechSynthesis), which in Obsidian's
  // Electron runs on the Mac's own installed voices -- same engine, same
  // System Settings > Accessibility > Spoken Content voice list a user
  // would pick from anywhere else on the machine.

  buildListenBar(content, r, appEl) {
    const bar = content.createDiv({ cls: 'a4r-listen-bar' });
    const backBtn = bar.createEl('button', { cls: 'a4r-listen-skip', text: '⏮' });
    setTooltip(backBtn, 'Back one sentence');
    const playBtn = bar.createEl('button', { cls: 'a4r-listen-play', text: '▶' });
    setTooltip(playBtn, 'Play');
    // Kokoro: have the model loaded before the first press, and start making
    // the first sentence as the pointer reaches Play.
    if (this.selectedKokoroVoice()) this.plugin.kokoroWarmUp();
    playBtn.addEventListener('mouseenter', () => this.kokoroPrefetchStart());
    const fwdBtn = bar.createEl('button', { cls: 'a4r-listen-skip', text: '⏭' });
    setTooltip(fwdBtn, 'Next sentence');
    const now = bar.createDiv({ cls: 'a4r-listen-now' });
    const chapEl = now.createDiv({ cls: 'a4r-listen-chap' });
    const sentEl = now.createDiv({ cls: 'a4r-listen-sent' });
    const meter = now.createDiv({ cls: 'a4r-listen-meter' });
    const meterFill = meter.createDiv({ cls: 'a4r-listen-meter-fill' });
    const speedChip = bar.createEl('button', { cls: 'a4r-chip a4r-listen-chip a4r-fs-speed' });
    setTooltip(speedChip, 'Reading speed');
    const voiceChip = bar.createEl('button', { cls: 'a4r-chip a4r-listen-chip a4r-listen-voice' });
    setTooltip(voiceChip, 'Voice');
    const hlChip = bar.createEl('button', { cls: 'a4r-chip a4r-listen-chip' });
    setTooltip(hlChip, 'Save the sentence being read as a highlight (H)');
    hlChip.createSpan({ text: 'Highlight sentence ' });
    hlChip.createEl('b', { text: 'H' });
    const stopChip = bar.createEl('button', { cls: 'a4r-chip a4r-listen-chip', text: 'Stop after chapter' });
    setTooltip(stopChip, 'Stop reading at the end of this chapter');
    // ✕ (v0.7.0) -- hides the bar the same way the toolbar's 🎧 button
    // does (hideListenBar()); margin-left:auto in styles.css keeps it
    // pinned to the bar's far end regardless of how many chips wrap.
    const closeBtn = bar.createEl('button', { cls: 'a4r-listen-close', text: '✕' });
    setTooltip(closeBtn, 'Hide the Listen bar');

    backBtn.onclick = () => this.stepSentence(-1, appEl);
    fwdBtn.onclick = () => this.stepSentence(1, appEl);
    playBtn.onclick = () => this.onPlayButtonClick(appEl);
    speedChip.onclick = () => this.cycleSpeed();
    voiceChip.onclick = (e) => this.showVoicePopup(e);
    hlChip.onclick = () => this.saveCurrentSentenceAsHighlight(appEl);
    stopChip.onclick = () => {
      r.tts = r.tts || {};
      r.tts.stopAfterChapter = !r.tts.stopAfterChapter;
      this.updateListenBarUI();
    };
    closeBtn.onclick = () => this.hideListenBar(appEl);

    r.listenBar = { root: bar, backBtn, playBtn, fwdBtn, chapEl, sentEl, meterFill, speedChip, voiceChip, hlChip, stopChip, closeBtn };
    this.updateListenBarUI();
    return bar;
  }

  updateListenBarUI() {
    const r = this.reader;
    if (!r || !r.listenBar) return;
    const lb = r.listenBar;
    const tts = r.tts;
    const hasSentences = !!(tts && tts.sentenceEls && tts.sentenceEls.length);
    // The icon has to reflect what the voice is actually doing, not only our
    // own flag: a voice can still be mid-utterance for a moment after a
    // resume/jump, and the button showing a play triangle while it talks is
    // the confusing case John hit.
    const synthSpeaking = !!(window.speechSynthesis && window.speechSynthesis.speaking && !window.speechSynthesis.paused);
    const isSpeaking = !!(tts && tts.playing) || (synthSpeaking && !(tts && tts.paused));
    lb.playBtn.setText(isSpeaking ? '❚❚' : '▶');
    // Full screen (v0.15.0): the Listen controls show at the top only
    // while Listen is playing or paused, and hide once it stops.
    const listenRoot = lb.playBtn.closest('.a4r-root');
    if (listenRoot) listenRoot.toggleClass('a4r-fs-listening', !!(tts && (tts.playing || tts.paused)) || synthSpeaking);
    setTooltip(lb.playBtn, isSpeaking ? 'Pause' : 'Play');
    lb.playBtn.disabled = !hasSentences;
    lb.backBtn.disabled = !hasSentences;
    lb.fwdBtn.disabled = !hasSentences;
    lb.hlChip.disabled = !hasSentences || !tts || tts.currentIndex < 0;
    lb.speedChip.setText(`Speed ${(this.plugin.settings.ttsSpeed || 1).toFixed(1)}×`);
    const voice = this.getSelectedVoice();
    lb.voiceChip.setText(voice ? `Voice: ${voice.name}` : 'Voice');
    lb.stopChip.toggleClass('a4r-on', !!(tts && tts.stopAfterChapter));
    if (r.format === 'pdf') {
      // Same bar as EPUB; a PDF has pages, not chapters.
      lb.stopChip.setText('Stop after page');
      setTooltip(lb.stopChip, 'Stop reading at the end of this page');
      this.pdfUpdateListenNow(lb, tts);
      return;
    }
    // Sentences only behave like clickable things while the voice is
    // actually PLAYING -- paused/stopped is plain book text again (no
    // hover underline, no pointer cursor, no click-to-jump). See
    // .a4r-tts-active in styles.css and the click listener's own comment
    // in rebuildTtsSentences() above.
    const host = r.epub && r.epub.columnsHost;
    if (host && host.isConnected) host.classList.toggle('a4r-tts-active', !!(tts && tts.playing));
    // Chapter page (v0.7.1) -- while the Listen bar is showing (the
    // reading-progress strip is hidden in its slot), the chapter's page
    // position has nowhere else to live, so it rides on this same line
    // that already carries the chapter title.
    const pageInChapter = r.epub && r.epub.pageCountInChapter
      ? `p. ${(r.epub.page || 0) + 1} of ${r.epub.pageCountInChapter}`
      : null;
    const chapterWithPage = (base) => (pageInChapter ? (base ? `${base} · ${pageInChapter}` : pageInChapter) : base);
    if (tts && tts.currentIndex >= 0 && tts.sentenceTexts && tts.sentenceTexts[tts.currentIndex]) {
      const mins = `${this.minutesLeftInChapter()} min left in chapter`;
      lb.chapEl.setText(`${chapterWithPage(tts.chapterLabel) || ''} · ${mins}`.replace(/^ · /, ''));
      lb.sentEl.setText(tts.sentenceTexts[tts.currentIndex]);
      const pct = tts.sentenceTexts.length ? ((tts.currentIndex + 1) / tts.sentenceTexts.length) * 100 : 0;
      lb.meterFill.style.width = `${Math.min(100, pct)}%`;
    } else {
      lb.chapEl.setText(chapterWithPage(tts && tts.chapterLabel ? tts.chapterLabel : '') || '');
      // "Loading…" is only accurate while the chapter's sentences haven't
      // been computed yet at all (tts is still null -- rebuildTtsSentences
      // hasn't run for this chapter/page render). Once it HAS run and
      // still found zero sentences (an image-only page, e.g. a cover, has
      // no real text to split), hasSentences stays false forever and the
      // bar would otherwise say "Loading…" permanently -- this is exactly
      // the stuck-loading bug reported (root cause was actually landing on
      // the wrong, image-only page; this message-fix is the belt-and-
      // suspenders half of it, matching the PDF branch's own equivalent
      // "no text to read aloud" message below).
      lb.sentEl.setText(hasSentences ? 'Press play to listen to this chapter.' : (tts ? 'No text to read aloud on this page.' : 'Loading…'));
      lb.meterFill.style.width = '0%';
    }
  }

  // hideListenBar / showListenBar (v0.7.0) -- the Listen bar's own ✕ and
  // the toolbar's 🎧 button both call these; the setting is global (not
  // per-book), same posture as pageColour/textSize. Hiding while the voice
  // is actually playing pauses it first via the existing pausePlayback()
  // (keeps r.tts.currentIndex/the saved listen_pos untouched, only the
  // on-page look and the bar itself disappear) -- per the approved
  // mockup's "Hiding while audio plays stops playback (keep listen
  // position)." isSpeaking check mirrors updateListenBarUI()'s own, since
  // r.tts.playing alone can lag a moment behind the real synth state.
  async hideListenBar(appEl) {
    const r = this.reader;
    if (r && r.tts) {
      const synthSpeaking = !!(window.speechSynthesis && window.speechSynthesis.speaking && !window.speechSynthesis.paused);
      const isSpeaking = !!r.tts.playing || (synthSpeaking && !r.tts.paused);
      if (isSpeaking) this.pausePlayback();
    }
    this.plugin.settings.listenBarHidden = true;
    await this.plugin.saveSettings();
    this.renderReader(appEl);
  }

  async showListenBar(appEl) {
    this.plugin.settings.listenBarHidden = false;
    await this.plugin.saveSettings();
    this.renderReader(appEl);
  }

  // computeReadingPace — this book's own real minutes-per-page from the
  // v0.6.1 SessionRecorder's 'read'-mode sessions (only sessions that
  // actually logged a turned page count toward this), once there are
  // enough real pages to trust it; otherwise the documented fallback. See
  // the constants above (READ_PACE_MIN_PAGES etc.) for why. A session
  // flagged implausiblePace (2026-09-23 fix -- see endCurrent()) is
  // excluded: flip-through noise that would otherwise drag the average
  // pace down and collapse "time left in book".
  computeReadingPace(book) {
    // v0.8.0: the counting itself moved to the top-level
    // computeReadingPaceFrom() so the Reading Dashboard uses the exact same
    // rule (same sessions, same flip-through exclusion) -- behaviour here
    // is unchanged.
    const rec = this.plugin.sessionRecorder;
    const p = computeReadingPaceFrom(rec && rec.sessions, book.path);
    if (p.minPerPage != null) return { minPerPage: p.minPerPage, estimated: false };
    return { minPerPage: FALLBACK_MIN_PER_PAGE, estimated: true };
  }

  formatMinutesAsHM(mins) {
    const m = Math.max(0, Math.round(mins));
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h > 0 ? `${h}h ${rem}m` : `${m} min`;
  }

  // computeProgressStripData — the numbers behind the reading progress
  // strip (chapter/section label, its fill fraction, minutes left in it,
  // and minutes left in the whole book). Returns null when there's nothing
  // sensible to show yet (e.g. the epub buffer hasn't loaded).
  //
  // "Left in book" (epub): extrapolated from the remaining BOOK BYTES
  // (the exact same byte-size weighting computeEpubProgressPercent already
  // uses for the p.X/Y · N% readout, so this stays consistent with it),
  // converted to an equivalent page count using THIS chapter's own real
  // bytes-per-page as the density -- no invented "average book page"
  // constant, since every spine item's real size is already known from
  // the open EPUB's zip entries. Falls back to a plain per-chapter page-
  // count extrapolation only in the degenerate case where no byte sizes
  // are available at all (documented, not expected on a real EPUB).
  computeProgressStripData(r, file, fm) {
    const book = this.bookInfo();
    if (!book) return null;
    const pace = this.computeReadingPace(book);
    if (r.format === 'pdf') {
      const page = r.pdf.page;
      const total = r.pdf.pageCount || null;
      let label = total ? `Page ${page} of ${total}` : `Page ${page}`;
      let sectionStart = 1;
      let sectionEnd = total;
      // A PDF has no chapters -- reuse whatever outline section the ☰
      // Contents panel already knows about (if it happens to be loaded;
      // never triggers loading it just for this strip) so "left in
      // chapter" means something narrower than the whole PDF when
      // possible, same spirit as EPUB's chapter grouping.
      if (Array.isArray(r.pdf.outline) && r.pdf.outline.length) {
        let cur = null;
        let next = null;
        for (const item of r.pdf.outline) {
          if (item.pageNumber <= page) cur = item;
          else if (next === null) next = item;
        }
        if (cur) { sectionStart = cur.pageNumber; sectionEnd = next ? next.pageNumber - 1 : total; }
        // Section page ("Title · p. 36 of 42", v0.7.1) mirrors the EPUB
        // strip's chapter-page label below, once we know the section's own
        // page range -- a plain title alone left the reader unable to tell
        // where they are within a (possibly long) PDF section.
        if (cur) {
          const secTotal = sectionEnd ? Math.max(1, sectionEnd - sectionStart + 1) : null;
          const posInSec = secTotal ? Math.min(secTotal, Math.max(1, page - sectionStart + 1)) : null;
          label = secTotal ? `${cur.title} · p. ${posInSec} of ${secTotal}` : cur.title;
        }
      }
      const sectionTotal = sectionEnd ? Math.max(1, sectionEnd - sectionStart + 1) : null;
      const fillPercent = sectionTotal
        ? Math.min(100, Math.max(0, ((page - sectionStart + 1) / sectionTotal) * 100))
        : (total ? Math.min(100, Math.max(0, (page / total) * 100)) : 0);
      const pagesLeftInChapter = sectionEnd != null ? Math.max(0, sectionEnd - page) : (total ? Math.max(0, total - page) : null);
      const pagesLeftInBook = total != null ? Math.max(0, total - page) : null;
      return {
        label,
        fillPercent,
        estimated: pace.estimated,
        chapterMinutes: pagesLeftInChapter != null ? Math.max(pagesLeftInChapter > 0 ? 1 : 0, Math.round(pagesLeftInChapter * pace.minPerPage)) : null,
        bookMinutes: pagesLeftInBook != null ? Math.max(pagesLeftInBook > 0 ? 1 : 0, Math.round(pagesLeftInBook * pace.minPerPage)) : null,
      };
    }
    // EPUB
    const spine = r.epub.spine;
    const entries = r.epub.entries;
    if (!Array.isArray(spine) || !spine.length || !entries) return null;
    const idx = r.epub.idx;
    const total = r.epub.pageCountInChapter || 1;
    const page = r.epub.page || 0;
    const chapters = r.epub.tocChapters || [];
    const info = chapters.length ? findChapterForSpineIdx(chapters, idx) : null;
    const chapterTitle = info ? info.title : `Chapter ${idx + 1}`;
    // Chapter name + chapter page together (v0.7.1), e.g. "INTRODUCTION ·
    // p. 36 of 42" -- the toolbar now shows whole-book position only, so
    // this is the one place the page-within-chapter denominator lives.
    const label = `${chapterTitle} · p. ${page + 1} of ${total}`;
    const fillPercent = Math.min(100, Math.max(0, ((page + 1) / total) * 100));
    const pagesLeftInChapter = Math.max(0, total - (page + 1));
    const chapterMinutes = Math.max(pagesLeftInChapter > 0 ? 1 : 0, Math.round(pagesLeftInChapter * pace.minPerPage));

    const sizes = spine.map((s) => entries.get(s.resolvedPath)?.uncompressedSize || 0);
    const totalBytes = sizes.reduce((a, b) => a + b, 0);
    const pctNow = computeEpubProgressPercent(spine, entries, idx, total, page);
    const bytesPerPageThisChapter = (sizes[idx] || 0) / total;
    let pagesLeftInBook;
    if (totalBytes > 0 && bytesPerPageThisChapter > 0) {
      const bytesRemaining = totalBytes * (1 - pctNow / 100);
      pagesLeftInBook = bytesRemaining / bytesPerPageThisChapter;
    } else {
      // Degenerate case (no real byte sizes to weight by) -- every
      // remaining chapter stands in for this chapter's own real page
      // count. Still real data (this chapter's actual pagination), just a
      // coarser guess than the byte-weighted path above.
      pagesLeftInBook = pagesLeftInChapter + (spine.length - 1 - idx) * total;
    }
    const bookMinutes = Math.max(pagesLeftInBook > 0 ? 1 : 0, Math.round(pagesLeftInBook * pace.minPerPage));
    return { label, fillPercent, estimated: pace.estimated, chapterMinutes, bookMinutes };
  }

  // buildProgressStrip / updateProgressStripUI (v0.7.0) -- takes the
  // Listen bar's own slot whenever the Listen bar is hidden (see
  // renderReader()), per the approved mockup. r.updateProgressStrip is
  // exposed the same way r.updateLocPct/r.updateBackToPosChip already are,
  // so a reflow that doesn't do a full renderReader() (a text-settings
  // change, or the epub pane-resize observer) can refresh it in place.
  buildProgressStrip(content, r, appEl) {
    const strip = content.createDiv({ cls: 'a4r-progress-strip' });
    const labelEl = strip.createSpan({ cls: 'a4r-ps-label' });
    const meter = strip.createDiv({ cls: 'a4r-ps-meter' });
    const meterFill = meter.createDiv({ cls: 'a4r-ps-meter-fill' });
    const captionEl = strip.createSpan();
    r.progressStrip = { root: strip, labelEl, meterFill, captionEl };
    const update = () => this.updateProgressStripUI();
    r.updateProgressStrip = update;
    update();
    return strip;
  }

  updateProgressStripUI() {
    const r = this.reader;
    if (!r || !r.progressStrip) return;
    const ps = r.progressStrip;
    const file = this.currentBook;
    if (!file) { ps.root.style.display = 'none'; return; }
    const fm = this.store.getFm(file);
    let data = null;
    try {
      data = this.computeProgressStripData(r, file, fm);
    } catch (err) {
      console.error('Reading Vault: progress strip computation failed', err);
    }
    if (!data) { ps.root.style.display = 'none'; return; }
    ps.root.style.display = '';
    ps.labelEl.setText(data.label);
    ps.meterFill.style.width = `${Math.round(data.fillPercent)}%`;
    ps.captionEl.empty();
    ps.captionEl.className = data.estimated ? 'a4r-ps-firsttime' : 'a4r-ps-caption';
    const tilde = data.estimated ? '~' : '';
    const chapterTxt = data.chapterMinutes != null ? `${tilde}${data.chapterMinutes} min` : null;
    const bookTxt = data.bookMinutes != null ? `${tilde}${this.formatMinutesAsHM(data.bookMinutes)}` : null;
    if (!data.estimated) {
      if (chapterTxt) { ps.captionEl.createEl('b', { text: chapterTxt }); ps.captionEl.appendText(' left in chapter'); }
      if (chapterTxt && bookTxt) ps.captionEl.appendText(' · ');
      if (bookTxt) { ps.captionEl.createEl('b', { text: bookTxt }); ps.captionEl.appendText(' left in book'); }
    } else {
      const parts = [];
      if (chapterTxt) parts.push(`${chapterTxt} left in chapter`);
      if (bookTxt) parts.push(`${bookTxt} left in book`);
      if (parts.length) ps.captionEl.appendText(`${parts.join(' · ')} (estimated at an average pace — this gets more accurate as you read)`);
    }
  }

  minutesLeftInChapter() {
    const r = this.reader;
    const tts = r && r.tts;
    if (!tts || !tts.sentenceTexts || tts.currentIndex < 0) return 0;
    const remaining = tts.sentenceTexts.slice(tts.currentIndex).join(' ');
    const words = remaining.split(/\s+/).filter(Boolean).length;
    const wpm = 155 * (this.plugin.settings.ttsSpeed || 1);
    return Math.max(1, Math.round(words / wpm));
  }

  // The voice that reads: the chosen language's default voice. English is
  // always Kokoro (the only voices offered for English, see the settings
  // page) -- a stall or failure is retried and, failing that, pauses
  // Listen rather than silently switching to a system voice. Other
  // languages read with this Mac's own voices, an explicit choice made in
  // Settings, unrelated to Kokoro at all.
  getSelectedVoice() {
    const plugin = this.plugin;
    const lang = plugin.readingLanguage();
    if (lang === 'en') {
      const id = this.selectedKokoroVoice();
      if (id) return { name: `Kokoro · ${id}`, voiceURI: `kokoro:${id}`, lang: 'en', kokoro: id };
      // Without Pro: the Mac English voice picked in Settings.
      const macChoice = plugin.voiceChoice('en');
      return plugin.systemVoices().find((v) => v.voiceURI === macChoice.default) || plugin.defaultSystemVoice('en');
    }
    const choice = plugin.voiceChoice(lang);
    return plugin.systemVoices().find((v) => v.voiceURI === choice.default) || plugin.defaultSystemVoice(lang);
  }

  cycleSpeed() {
    const cur = this.plugin.settings.ttsSpeed || 1.0;
    let idx = TTS_SPEEDS.findIndex((s) => Math.abs(s - cur) < 0.001);
    idx = (idx + 1) % TTS_SPEEDS.length;
    this.plugin.settings.ttsSpeed = TTS_SPEEDS[idx];
    this.plugin.saveSettings();
    this.updateListenBarUI();
  }

  showVoicePopup(e) {
    document.querySelectorAll('.a4r-voice-popup').forEach((n) => n.remove());
    const rect = e.currentTarget.getBoundingClientRect();
    const popup = (document.fullscreenElement || document.body).createDiv({ cls: 'a4r-voice-popup' });
    popup.style.left = `${Math.max(8, rect.left)}px`;
    popup.style.top = `${rect.bottom + 6}px`;
    const current = this.getSelectedVoice();
    // Only the voices ticked for the reading language (Settings → A4
    // Reading). Picking one makes it that language's default.
    const plugin = this.plugin;
    const lang = plugin.readingLanguage();
    const choice = plugin.voiceChoice(lang);
    for (const id of choice.ticked) {
      const v = plugin.voiceInfo(id);
      if (!v) continue; // a system voice no longer installed
      const row = popup.createEl('button', { cls: `a4r-voice-row${v.kokoro ? ' a4r-voice-kokoro' : ''}`, text: `${v.label} (${v.lang})` });
      if (current && id === current.voiceURI) row.addClass('a4r-on');
      row.onclick = () => {
        choice.default = id;
        plugin.saveSettings();
        popup.remove();
        this.updateListenBarUI();
        if (v.kokoro) {
          // Choosing it is the explicit go-ahead for the one-time download
          // (and a retry if an earlier load failed this session).
          if (plugin.kokoroFailed) { plugin.kokoroFailed = false; plugin.kokoroLoading = null; }
          plugin.kokoroLoad().catch(() => {});
        }
      };
    }
    const closeOnOutside = (ev) => {
      if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('mousedown', closeOnOutside, true); }
    };
    window.setTimeout(() => document.addEventListener('mousedown', closeOnOutside, true), 0);
  }

  // rangeFromOffsets — like findTextRange, but from known [start,end)
  // character offsets into the concatenation of `nodes` (built once per
  // chapter by rebuildTtsSentences) rather than searching for a substring.
  rangeFromOffsets(nodes, start, end) {
    const startInfo = nodes.find((x) => start >= x.start && start < x.end);
    const endInfo = [...nodes].reverse().find((x) => end > x.start && end <= x.end);
    if (!startInfo || !endInfo) return null;
    const range = document.createRange();
    range.setStart(startInfo.node, start - startInfo.start);
    range.setEnd(endInfo.node, end - endInfo.start);
    return range;
  }

  // computePageForElement — which page (0-based, within the current
  // chapter) an already-wrapped sentence <span> falls on, independent of
  // the columnsHost's current translateX. columnsHost's own bounding rect
  // already reflects the current offset, so (elRect.left - hostRect.left)
  // is the sentence's position in the untransformed column flow.
  // The element a link's "#name" points to: by id, or an old-style
  // <a name="...">.
  findAnchorElement(root, name) {
    if (!name) return null;
    for (const el of root.querySelectorAll('[id], a[name]')) {
      if (el.getAttribute('id') === name || (el.tagName === 'A' && el.getAttribute('name') === name)) return el;
    }
    return null;
  }

  computePageForElement(el, columnsHost, r) {
    const elRect = el.getBoundingClientRect();
    const hostRect = columnsHost.getBoundingClientRect();
    const unit = (r.epub.pageWidth || 1) + (r.epub.pageGap || 0);
    const flowX = elRect.left - hostRect.left;
    const total = r.epub.pageCountInChapter || 1;
    return Math.max(0, Math.min(total - 1, Math.floor(flowX / unit)));
  }

  // rebuildTtsSentences — splits the just-rendered chapter into sentences,
  // wraps each one in a clickable <span class="a4r-tts-sentence"> (reverse
  // document order so earlier ranges' text-node offsets stay valid — later
  // extractions only ever truncate a node's tail, never its head), and
  // records which page each sentence lands on. Runs every time this
  // chapter's DOM is (re)built, since renderEpubPage reparses the chapter
  // HTML from scratch on every page turn — same rebuild-every-render
  // posture as drawSavedHighlights() above.
  rebuildTtsSentences(columnsHost, r, appEl, chapterLabel) {
    const priorPlayingSameChapter = r.tts && r.tts.chapterIdx === r.epub.idx && (r.tts.playing || r.tts.paused);
    const priorIndex = r.tts ? r.tts.currentIndex : -1;
    const pendingAutoplay = !!(r.tts && r.tts.pendingAutoplayFromTop);
    const pendingResume = r.tts && typeof r.tts.pendingResumeSentIdx === 'number' ? r.tts.pendingResumeSentIdx : null;
    const stopAfterChapter = r.tts ? !!r.tts.stopAfterChapter : false;
    const keepAliveTimer = r.tts ? r.tts.keepAliveTimer : null;

    // Footnote/endnote marker text (see isFootnoteMarkerAnchor/
    // .a4r-footnote-marker) is excluded from both the spoken text and the
    // sentence-boundary math entirely -- it's not part of the book's own
    // prose, it should never be read aloud, and leaving it in would abut it
    // directly against the punctuation that ends the real sentence before
    // it (no space in the book's own markup), which defeats
    // splitIntoSentences' abbreviation guard and merges unrelated sentences
    // together. acceptNode rejects a text node whose nearest ancestor is
    // one of these markers; FILTER_REJECT (not SKIP) also skips that
    // element's children, which is correct here since a marker anchor never
    // nests another one.
    const walker = document.createTreeWalker(columnsHost, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => ((n.parentElement && n.parentElement.closest('.a4r-footnote-marker'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    let full = '';
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: full.length, end: full.length + node.nodeValue.length });
      full += node.nodeValue;
    }
    const sentences = splitIntoSentences(full);
    const els = new Array(sentences.length).fill(null);
    for (let i = sentences.length - 1; i >= 0; i -= 1) {
      const s = sentences[i];
      const range = this.rangeFromOffsets(nodes, s.start, s.end);
      if (!range) continue;
      try {
        const span = document.createElement('span');
        span.className = 'a4r-tts-sentence';
        span.dataset.a4rSentIdx = String(i);
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
        els[i] = span;
      } catch { /* an awkward boundary (e.g. crossing an existing highlight <mark>) — skip, sentence still speaks fine without a click target */ }
    }
    // Click-to-jump is deliberately inert unless the voice is already
    // running. Making every sentence a play trigger broke ordinary text
    // selection: dragging across a paragraph to make a highlight ended on a
    // sentence <span>, which fired this click and started reading aloud.
    // Rules: nothing at all happens when speech is idle OR paused/stopped
    // (the event just proceeds, so native selection and normal reading
    // work) -- only while the voice is actually PLAYING does a genuine
    // *click* (no selection, pointer barely moved, short press) jump the
    // voice to that sentence. Deliberately narrower than "playing or
    // paused": with a paused voice, clicking a word to just read normally
    // used to restart playback instead -- see pausePlayback()/stopPlayback(),
    // which clear the highlighting this listener would otherwise still
    // react to. A drag is left alone for the highlight flow in
    // wireHighlighting(), which pauses the voice and resumes it when the
    // color popup closes.
    columnsHost.querySelectorAll('.a4r-tts-sentence').forEach((el) => {
      el.addEventListener('click', (ev) => {
        const tts = this.reader && this.reader.tts;
        if (!tts || !tts.playing) return;
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim()) return;
        const down = columnsHost._a4rPointerDown;
        if (down) {
          const moved = Math.abs(ev.clientX - down.x) > 5 || Math.abs(ev.clientY - down.y) > 5;
          if (moved || Date.now() - down.t > 300) return;
        }
        const idx = parseInt(el.dataset.a4rSentIdx, 10);
        if (!Number.isFinite(idx)) return;
        if (this.plugin.kokoroCancelPending) this.plugin.kokoroCancelPending();
        this.playFromSentenceIndex(idx, appEl);
      });
    });

    r.tts = {
      playing: false,
      paused: false,
      currentIndex: priorPlayingSameChapter ? Math.max(0, Math.min(els.length - 1, priorIndex)) : -1,
      chapterIdx: r.epub.idx,
      chapterLabel,
      stopAfterChapter,
      keepAliveTimer,
      sentenceEls: els,
      sentenceTexts: sentences.map((s) => s.text),
      utterance: null,
      pendingAutoplayFromTop: false,
      pendingResumeSentIdx: null,
    };
    r.tts.sentencePages = els.map((el) => (el ? this.computePageForElement(el, columnsHost, r) : r.epub.page));

    if (pendingAutoplay && !els.length) {
      // A picture-only page between chapters (QA fix v0.17.3): nothing to
      // read here, so carry straight on to the next chapter instead of
      // stopping for good.
      const tts = r.tts;
      tts.playing = true;
      window.setTimeout(() => {
        if (this.reader === r && r.tts === tts && tts.playing) this.advanceOrStop(appEl);
      }, 0);
    } else if (pendingAutoplay) {
      this.playFromSentenceIndex(0, appEl);
    } else if (typeof pendingResume === 'number') {
      this.playFromSentenceIndex(pendingResume, appEl);
    } else if (priorPlayingSameChapter) {
      r.tts.playing = true;
      this.plugin.sessionRecorder.noteActivity(this.bookInfo(), 'listen', 0);
      this.highlightSentence(r.tts.currentIndex);
    } else {
      this.updateListenBarUI();
    }
    // Freshly rebuilt DOM: make sure the "voice is running" state is
    // reflected on this chapter's sentences (hover underline/pointer only
    // while actually playing, not paused/stopped).
    columnsHost.classList.toggle('a4r-tts-active', !!r.tts.playing);
  }

  highlightSentence(idx) {
    if (this.reader && this.reader.format === 'pdf') { this.pdfRedrawListenMark(); this.updateListenBarUI(); return; }
    const r = this.reader;
    if (!r || !r.tts || !r.tts.sentenceEls) return;
    // A sentence whose DOM range couldn't be wrapped in a <span> (an awkward
    // cross-element boundary -- see rebuildTtsSentences' own extractContents
    // try/catch) has no el of its own. Showing no highlight at all while
    // the voice reads it is a silent desync: the visible marker should
    // never just vanish, it should fall forward to the next sentence that
    // DOES have a wrapped span, so something is always shown close to where
    // the voice actually is. "done" (already-read) styling still uses the
    // real idx, so read-but-unwrapped sentences are correctly marked passed
    // once the voice moves beyond them.
    let showIdx = idx;
    if (showIdx >= 0 && !r.tts.sentenceEls[showIdx]) {
      const next = r.tts.sentenceEls.findIndex((el, i) => i > showIdx && el);
      if (next !== -1) showIdx = next;
    }
    r.tts.sentenceEls.forEach((el, i) => {
      if (!el) return;
      el.classList.toggle('a4r-tts-current', i === showIdx);
      el.classList.toggle('a4r-tts-done', i < idx);
    });
    this.updateListenBarUI();
    this.followScrollToSentence(r.tts.sentenceEls[showIdx]);
  }

  // Keep the spoken sentence in view when the page itself scrolls (a long
  // PDF page, or an EPUB chapter that fell back to plain scrolling instead
  // of column pagination). Paginated EPUB pages don't need this -- turnToPage
  // already keeps the whole page in view by moving the column strip, so this
  // is a no-op there. Only scrolls once the sentence actually nears/passes
  // the bottom edge (not on every sentence) so the page doesn't creep on
  // every line. Stops following the instant the user scrolls by hand
  // (see the container 'scroll' listeners in renderEpubPage/renderPdfPage)
  // and resumes when they tap a sentence or press play (playFromSentenceIndex
  // / pdfPlayFrom reset r.followScroll = true).
  followScrollToSentence(el) {
    const r = this.reader;
    if (!r || r.followScroll === false || !el || !el.isConnected) return;
    if (r.format === 'epub' && this.canFollowPages()) return;
    const container = el.closest('.a4r-page-viewport') || el.closest('.a4r-reader-page');
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.bottom <= cRect.bottom - 24 && eRect.top >= cRect.top) return;
    this._programmaticScrollAt = Date.now();
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* not fatal, follow just misses this tick */ }
  }

  // A real scroll event within ~700ms of our own followScrollToSentence()
  // call is assumed to be the tail of that smooth scroll, not the user --
  // scrollIntoView's smooth animation fires many 'scroll' events over a few
  // hundred ms. Anything outside that window is the user scrolling by hand,
  // which turns following off until they tap a sentence or press play.
  wireScrollFollowRelease(container) {
    container.addEventListener('scroll', () => {
      if (Date.now() - (this._programmaticScrollAt || 0) < 700) return;
      if (this.reader) this.reader.followScroll = false;
      // A real hand-scroll counts as reading activity for the idle check --
      // but only when not currently listening, so it isn't misclassified
      // as a 'read' session while audio is actually doing the reading.
      if (!(this.reader && this.reader.tts && this.reader.tts.playing)) {
        this.plugin.sessionRecorder.noteActivity(this.bookInfo(), 'read', 0);
      }
    });
  }

  findFirstSentenceIndexOnPage(page) {
    const r = this.reader;
    if (!r.tts || !r.tts.sentencePages || !r.tts.sentencePages.length) return 0;
    const idx = r.tts.sentencePages.findIndex((p) => p >= page);
    // No sentence starts on this page or later (the chapter's last page
    // holds only the end of one): that last sentence, not the start of the
    // chapter (QA fix v0.17.3).
    return idx === -1 ? r.tts.sentencePages.length - 1 : idx;
  }

  parseListenPos(v) {
    if (typeof v !== 'string') return null;
    const m = /^spine:(\d+):sent:(\d+)$/.exec(v);
    if (!m) return null;
    return { spineIdx: parseInt(m[1], 10), sentIdx: parseInt(m[2], 10) };
  }

  // listen_pos: "spine:<chapter>:sent:<n>" for EPUB, "page:<p>:nw:<n>"
  // for PDF (<n> = the sentence's first non-space character on that page,
  // which doesn't shift with where reading started).
  listenPosValue(r) {
    if (r.format === 'pdf') {
      const info = r.tts.sentenceInfo && r.tts.sentenceInfo[r.tts.currentIndex];
      return info ? `page:${info.startPage}:nw:${info.startNW}` : null;
    }
    // No sentence yet means nothing to save (QA fix v0.17.3: "sent:-1"
    // used to overwrite the real resume point).
    if (!(r.tts.currentIndex >= 0)) return null;
    return `spine:${r.epub.idx}:sent:${r.tts.currentIndex}`;
  }

  // Called on every sentence advance during Listen (every few seconds of
  // real speech). Root cause of the constant-Sync-upload bug: a flat 1500ms
  // debounce still fires almost every sentence, because most sentences take
  // longer than 1.5s to speak -- the timer never gets re-cancelled before it
  // fires, so `listen_pos` was writing (and Syncing) the whole book note on
  // a ~1.5s cadence for the entire time Listen played. Throttled instead:
  // at most one write per ~30s while playback keeps going, always the
  // latest value at write time, and skipped entirely when the value hasn't
  // actually changed since the last write. Real "this matters right now"
  // moments (page/chapter change, pause, stop, closing the book) already go
  // through flushListenPosition(), which bypasses this throttle.
  saveListenPosition() {
    const r = this.reader;
    if (!r || !r.tts || r.tts.currentIndex < 0 || !this.currentBook) return;
    const val = this.listenPosValue(r);
    if (!val || val === this._lastSavedListenPos) return;
    if (this._listenSaveTimer) return; // a write is already scheduled; it will pick up the latest value when it fires
    const book = this.currentBook;
    const elapsed = Date.now() - (this._lastListenSaveAt || 0);
    const delay = Math.max(0, LISTEN_POS_THROTTLE_MS - elapsed);
    this._listenSaveTimer = window.setTimeout(() => {
      this._listenSaveTimer = null;
      this._lastListenSaveAt = Date.now();
      if (this.reader !== r || !r.tts || r.tts.currentIndex < 0) return; // book/chapter changed mid-wait
      const cur = this.listenPosValue(r);
      if (!cur || cur === this._lastSavedListenPos) return;
      this._lastSavedListenPos = cur;
      this.store.updateBookFields(book, { listen_pos: cur });
    }, delay);
  }

  flushListenPosition() {
    if (this._listenSaveTimer) { window.clearTimeout(this._listenSaveTimer); this._listenSaveTimer = null; }
    const r = this.reader;
    if (r && r.tts && r.tts.currentIndex >= 0 && this.currentBook) {
      const val = this.listenPosValue(r);
      if (val && val !== this._lastSavedListenPos) {
        this._lastSavedListenPos = val;
        this._lastListenSaveAt = Date.now();
        this.store.updateBookFields(this.currentBook, { listen_pos: val });
      }
    }
  }

  startKeepAlive() {
    this.stopKeepAlive();
    // Chromium's speechSynthesis can go silent after ~15s of continuous
    // speaking on some builds. Utterances here are one sentence long, which
    // mostly avoids it, but this ticker is cheap insurance for a long
    // sentence.
    if (!this.reader || !this.reader.tts) return;
    this.reader.tts.keepAliveTimer = window.setInterval(() => {
      if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 10000);
  }

  stopKeepAlive() {
    if (this.reader && this.reader.tts && this.reader.tts.keepAliveTimer) {
      window.clearInterval(this.reader.tts.keepAliveTimer);
      this.reader.tts.keepAliveTimer = null;
    }
  }

  onPlayButtonClick(appEl) {
    if (this.reader && this.reader.format === 'pdf') { this.pdfOnPlayButtonClick(appEl); return; }
    const r = this.reader;
    if (!r || !r.tts || !r.tts.sentenceEls || !r.tts.sentenceEls.length) return;
    if (r.tts.playing) { this.pausePlayback(); return; }
    if (r.tts.paused && r.tts.chapterIdx === r.epub.idx) { this.resumePlayback(appEl); return; }

    // Fresh start. Offer the simplest form of "resume from where the voice
    // stopped": if a saved listen position exists and it's ahead of where
    // the reader currently is, jump straight there and say so, rather than
    // making the user hunt for it.
    const fm = this.store.getFm(this.currentBook);
    const resume = this.parseListenPos(fm.listen_pos);
    // Only ever forward (QA fix v0.17.3): a saved Listen spot in an earlier
    // chapter used to pull the reader back there and save that as their
    // reading position, losing the chapters read by hand since.
    if (resume && resume.spineIdx > r.epub.idx && resume.spineIdx < r.epub.spine.length) {
      r.epub.idx = resume.spineIdx;
      r.epub.page = 0;
      r.tts.pendingResumeSentIdx = resume.sentIdx;
      new Notice('Resuming from where the voice stopped.');
      this.scheduleProgressSave();
      this.renderReader(appEl);
      return;
    }
    let startIdx = this.findFirstSentenceIndexOnPage(r.epub.page);
    if (resume && resume.spineIdx === r.epub.idx && resume.sentIdx > startIdx) {
      startIdx = Math.min(resume.sentIdx, r.tts.sentenceEls.length - 1);
      new Notice('Resuming from where the voice stopped.');
    }
    this.playFromSentenceIndex(startIdx, appEl);
  }

  // clearListenVisuals — on pause or stop, the page should look like
  // normal reading again: no current-sentence highlight, no underline on
  // hover, no dimmed "already read" text. The saved listen position
  // (currentIndex / listen_pos) is untouched here -- only the on-page
  // look is cleared, so Play still resumes from the right spot. EPUB
  // clears the per-sentence classes directly; PDF's mark is a redrawn
  // overlay (drawPdfListenMark) that already checks tts.playing, so
  // asking it to redraw after playing/paused are both false removes it.
  clearListenVisuals() {
    const r = this.reader;
    if (!r || !r.tts) return;
    if (r.format === 'pdf') { this.pdfRedrawListenMark(); return; }
    if (r.tts.sentenceEls) {
      r.tts.sentenceEls.forEach((el) => {
        if (el) el.classList.remove('a4r-tts-current', 'a4r-tts-done');
      });
    }
    const host = r.epub && r.epub.columnsHost;
    if (host && host.isConnected) host.classList.remove('a4r-tts-active');
  }

  pausePlayback() {
    const r = this.reader;
    if (!r || !r.tts) return;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.kokoroStopAudio();
    this.plugin.kokoroCancelPending();
    this.stopKeepAlive();
    r.tts.playing = false;
    r.tts.paused = true;
    this.flushListenPosition();
    this.clearListenVisuals();
    this.updateListenBarUI();
  }

  resumePlayback(appEl) {
    const r = this.reader;
    if (!r || !r.tts || r.tts.currentIndex < 0) return;
    this.playFromSentenceIndex(r.tts.currentIndex, appEl);
  }

  stopPlayback() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.kokoroStopAudio();
    if (this.plugin.kokoroCancelPending) this.plugin.kokoroCancelPending();
    this.stopKeepAlive();
    if (this.reader && this.reader.tts) {
      this.reader.tts.playing = false;
      this.reader.tts.paused = false;
    }
    this.flushListenPosition();
    this.clearListenVisuals();
  }

  stepSentence(delta, appEl) {
    const r = this.reader;
    if (!r || !r.tts || !r.tts.sentenceEls || !r.tts.sentenceEls.length) return;
    const base = r.tts.currentIndex < 0 ? 0 : r.tts.currentIndex;
    const next = Math.max(0, Math.min(r.tts.sentenceEls.length - 1, base + delta));
    // Drop the natural voice's queued lookahead first, so a quick run of
    // skips doesn't wait for every skipped sentence to be made.
    if (this.plugin.kokoroCancelPending) this.plugin.kokoroCancelPending();
    this.playFromSentenceIndex(next, appEl);
  }

  playFromSentenceIndex(idx, appEl) {
    if (this.reader && this.reader.format === 'pdf') { this.pdfPlayFrom(idx, appEl); return; }
    const r = this.reader;
    if (!r || !r.tts || !r.tts.sentenceEls || !r.tts.sentenceEls.length) return;
    r.followScroll = true; // tapping a sentence or pressing play resumes auto-scroll
    idx = Math.max(0, Math.min(r.tts.sentenceEls.length - 1, idx));
    const targetPage = r.tts.sentencePages ? r.tts.sentencePages[idx] : r.epub.page;
    r.tts.currentIndex = idx;
    r.tts.playing = true;
    r.tts.paused = false;
    this.plugin.sessionRecorder.noteActivity(this.bookInfo(), 'listen', 0);
    if (this.canFollowPages()) {
      // followSentence() decides the page (and does nothing if we're already
      // on it); either way no full re-render, so the sentence spans stay put.
      this.followSentence(idx);
      this.highlightSentence(idx);
    } else if (targetPage !== r.epub.page) {
      // Turn to the page the sentence is actually on using the reader's own
      // page-offset machinery -- a full renderReader() re-parses the
      // chapter and calls rebuildTtsSentences() again, which sees
      // chapterIdx unchanged and currentIndex already set, so it picks the
      // highlight back up on the fresh DOM before we speak.
      r.epub.page = targetPage;
      this.scheduleProgressSave();
      this.renderReader(appEl);
    } else {
      this.highlightSentence(idx);
    }
    this.speakCurrentSentence(appEl);
    this.saveListenPosition();
    this.updateListenBarUI();
  }

  // sentencePageRange — which page a sentence STARTS on and which page it
  // ENDS on, measured from the Range over the whole sentence (its individual
  // client rects), not the span's single bounding rect. A sentence that
  // straddles a page break has one rect on each page; the bounding rect of
  // the span would span both and always report the earlier one.
  sentencePageRange(el, r) {
    const host = r.epub && r.epub.columnsHost;
    if (!host || !el || !el.isConnected || !r.epub.pageWidth) return null;
    let rects;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      rects = Array.from(range.getClientRects()).filter((x) => x.width > 0 || x.height > 0);
    } catch { return null; }
    if (!rects.length) return null;
    const hostLeft = host.getBoundingClientRect().left;
    const unit = (r.epub.pageWidth || 1) + (r.epub.pageGap || 0);
    const total = r.epub.pageCountInChapter || 1;
    const pageOf = (x) => Math.max(0, Math.min(total - 1, Math.floor((x - hostLeft) / unit)));
    const pages = rects.map((x) => pageOf(x.left));
    return { start: Math.min(...pages), end: Math.max(...pages) };
  }

  // turnToPage — the same page turn the arrows do, minus the full
  // re-render: move the column strip with applyEpubPageOffset(), update the
  // "p.N/M" label, the arrows' disabled state and saved progress. Keeping
  // the chapter DOM alive matters mid-speech, since the sentence spans (and
  // the current-sentence marker) would otherwise be rebuilt underneath the
  // voice on every page turn.
  turnToPage(page) {
    const r = this.reader;
    if (!r || r.format !== 'epub') return false;
    const host = r.epub.columnsHost;
    if (!host || !host.isConnected || !r.epub.pageWidth) return false;
    const total = r.epub.pageCountInChapter || 1;
    const target = Math.max(0, Math.min(total - 1, Number.isFinite(page) ? page : 0));
    if (target === r.epub.page) return false;
    r.epub.page = target;
    this.applyEpubPageOffset(host, r);
    if (r.prevBtn) r.prevBtn.disabled = r.epub.idx <= 0 && r.epub.page <= 0;
    if (r.nextBtn) r.nextBtn.disabled = r.epub.idx >= r.epub.spine.length - 1 && r.epub.page >= total - 1;
    if (r.updateLocPct) r.updateLocPct();
    if (r.updateProgressStrip) r.updateProgressStrip();
    this.scheduleProgressSave();
    if (r.updateBackToPosChip) r.updateBackToPosChip();
    return true;
  }

  // canFollowPages — the lightweight turn is available (chapter DOM alive and
  // actually paginated). When it isn't (plain scrolling fallback, or a leaf
  // that hasn't been measured yet), callers fall back to a full re-render.
  canFollowPages() {
    const r = this.reader;
    const host = r && r.epub && r.epub.columnsHost;
    return !!(r && r.format === 'epub' && host && host.isConnected && r.epub.pageWidth);
  }

  // followSentence — keep the visible page with the voice. Called when a
  // sentence is queued AND again from its utterance's onstart (some voices
  // never fire onstart, and queue time can be a frame before layout has
  // settled -- doing both is idempotent, the second call is a no-op when the
  // page is already right). Lands on the page where the sentence ENDS: a
  // sentence split across a page break has most of its text there, so
  // staying on the start page would leave the reader staring at one word.
  followSentence(idx) {
    const r = this.reader;
    if (!r || !r.tts || r.format !== 'epub') return false;
    // Never yank the page out from under a selection the user is making.
    const sel = window.getSelection();
    const host = r.epub.columnsHost;
    if (sel && sel.rangeCount && !sel.isCollapsed && host && host.contains(sel.anchorNode)) return false;
    const el = r.tts.sentenceEls && r.tts.sentenceEls[idx];
    const range = el ? this.sentencePageRange(el, r) : null;
    let target = range ? range.end : null;
    if (!Number.isFinite(target)) target = r.tts.sentencePages ? r.tts.sentencePages[idx] : null;
    if (!Number.isFinite(target)) return false;
    return this.turnToPage(target);
  }

  speakCurrentSentence(appEl) {
    const r = this.reader;
    if (!window.speechSynthesis || !r || !r.tts) return;
    window.speechSynthesis.cancel();
    const text = r.tts.sentenceTexts[r.tts.currentIndex];
    if (!text) { this.advanceOrStop(appEl); return; }
    const selected = this.getSelectedVoice();
    if (selected && selected.kokoro) { this.kokoroSpeakCurrent(appEl, selected.kokoro); return; }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = this.plugin.settings.ttsSpeed || 1.0;
    const voice = this.getSelectedVoice();
    if (voice) utter.voice = voice;
    const myIndex = r.tts.currentIndex;
    const myChapter = r.epub.idx;
    if (r.format === 'pdf') this.pdfTurnMidSentence(utter, myIndex, appEl);
    // Turn the page (if needed) BEFORE the sentence is spoken, and again
    // when it actually starts -- see followSentence().
    this.followSentence(myIndex);
    utter.onstart = () => {
      const cur = this.reader;
      if (!cur || !cur.tts || cur.tts.currentIndex !== myIndex || cur.epub.idx !== myChapter) return;
      this.followSentence(myIndex);
      this.updateListenBarUI();
    };
    utter.onend = () => {
      const cur = this.reader;
      if (!cur || !cur.tts || !cur.tts.playing) return;
      if (cur.tts.currentIndex !== myIndex || cur.epub.idx !== myChapter) return; // stale utterance from a cancelled/superseded sentence
      this.advanceOrStop(appEl);
    };
    utter.onerror = (ev) => {
      if (ev && (ev.error === 'interrupted' || ev.error === 'canceled')) return; // our own cancel(), not a real failure
      const cur = this.reader;
      if (!cur || !cur.tts || !cur.tts.playing) return;
      if (cur.tts.currentIndex !== myIndex || cur.epub.idx !== myChapter) return; // an older sentence's error
      // A voice that fails fails on every sentence: pause right here rather
      // than racing on to the end of the book and saving that as the place
      // (QA fix v0.17.3).
      console.error('Reading Vault: the Mac voice failed', ev && ev.error);
      this.pausePlayback();
      new Notice('The voice stopped. Press play to try again.');
    };
    r.tts.utterance = utter;
    window.speechSynthesis.speak(utter);
    this.startKeepAlive();
  }

  advanceOrStop(appEl) {
    if (this.reader && this.reader.format === 'pdf') { this.pdfAdvance(appEl); return; }
    const r = this.reader;
    if (!r || !r.tts) return;
    const nextIdx = r.tts.currentIndex + 1;
    if (nextIdx < r.tts.sentenceEls.length) {
      r.tts.currentIndex = nextIdx;
      const targetPage = r.tts.sentencePages ? r.tts.sentencePages[nextIdx] : r.epub.page;
      if (this.canFollowPages()) {
        this.followSentence(nextIdx);
        this.highlightSentence(nextIdx);
      } else if (targetPage !== r.epub.page) {
        r.epub.page = targetPage;
        this.scheduleProgressSave();
        this.renderReader(appEl);
      } else {
        this.highlightSentence(nextIdx);
      }
      this.speakCurrentSentence(appEl);
      this.saveListenPosition();
      this.updateListenBarUI();
      return;
    }
    // End of chapter.
    if (r.tts.stopAfterChapter || r.epub.idx >= r.epub.spine.length - 1) {
      this.stopPlayback();
      this.updateListenBarUI();
      return;
    }
    r.epub.idx += 1;
    r.epub.page = 0;
    r.tts.pendingAutoplayFromTop = true;
    this.scheduleProgressSave();
    this.renderReader(appEl);
  }

  // ==================== LISTEN — KOKORO VOICE ====================
  // Same sentence-by-sentence loop as the system voice: speakCurrentSentence
  // hands each sentence here when a Kokoro voice is chosen. Audio is made a
  // sentence or two ahead (one generation at a time -- the model is a single
  // ONNX session) and played through Web Audio; onstart/onend drive the same
  // page following, highlighting and advancing as the system voice's events.

  // Note: NOT gated on plugin.kokoroFailed -- that flag no longer means
  // "give up on Kokoro for this session" (it never triggers a switch to the
  // system voice; see kokoroSpeakCurrent's failed()). English always offers
  // the chosen Kokoro voice, session after session, retry after retry.
  selectedKokoroVoice() {
    const plugin = this.plugin;
    if (plugin.readingLanguage() !== 'en' || !plugin.naturalVoicesUnlocked()) return null;
    const id = plugin.voiceChoice('en').default;
    return typeof id === 'string' && id.startsWith('kokoro:') ? id.slice('kokoro:'.length) : 'af_heart';
  }

  kokoroLoad() { return this.plugin.kokoroLoad(); }

  kokoroAudioFor(text, voiceId) { return this.plugin.kokoroAudioFor(text, voiceId); }

  // The sentence Play would start from (same choice as the play button makes
  // for a fresh start), made ahead of the click.
  kokoroPrefetchStart() {
    const r = this.reader;
    const voiceId = this.selectedKokoroVoice();
    if (!r || !r.tts || !voiceId || r.tts.playing || r.tts.paused || !this.plugin.kokoroTts) return;
    let idx = -1;
    if (r.format === 'pdf') {
      if (!r.tts.sentenceInfo) return;
      idx = r.tts.sentenceInfo.findIndex((x) => x.startPage !== null && x.startPage >= r.pdf.page);
    } else if (r.tts.sentencePages) {
      idx = this.findFirstSentenceIndexOnPage(r.epub.page);
    }
    const text = idx >= 0 ? r.tts.sentenceTexts[idx] : null;
    if (!text) return;
    // Same pieces the first press will ask for (see kokoroSpeakCurrent).
    for (const t of this.kokoroSplit(text) || [text]) this.kokoroAudioFor(t, voiceId).catch(() => {});
  }

  // Start making the next two sentences while this one plays.
  kokoroPrefetch(r, idx, voiceId) {
    for (const i of [idx + 1, idx + 2]) {
      const t = r.tts.sentenceTexts[i];
      if (t) this.kokoroAudioFor(t, voiceId).catch(() => {});
    }
  }

  // A stall (KOKORO_GEN_TIMEOUT) or any other Kokoro failure on the current
  // sentence retries the SAME sentence with the SAME chosen voice, up to
  // KOKORO_MAX_RETRIES times with a short backoff between tries. If it
  // still hasn't worked after that, Listen pauses right there -- position
  // and highlight stay put (pausePlayback() doesn't move currentIndex or
  // clear the highlight) -- with one plain Notice. It never falls back to
  // the system voice; John's decision 2026-09-23.
  kokoroSpeakCurrent(appEl, voiceId, attempt = 0) {
    const r = this.reader;
    const myIndex = r.tts.currentIndex;
    const myChapter = r.epub.idx;
    const text = r.tts.sentenceTexts[myIndex];
    this.kokoroStopAudio();
    const token = this.kokoroToken;
    this.followSentence(myIndex);
    const stillCurrent = () => {
      const cur = this.reader;
      return token === this.kokoroToken && cur === r && cur.tts && cur.tts.playing && cur.tts.currentIndex === myIndex && cur.epub.idx === myChapter;
    };
    const failed = (err) => {
      if (token !== this.kokoroToken || (err && err.message === KOKORO_CANCELLED)) return;
      console.error('Reading Vault: Kokoro voice failed', err, { attempt });
      if (!stillCurrent()) return;
      if (attempt < KOKORO_MAX_RETRIES) {
        window.setTimeout(() => {
          if (stillCurrent()) this.kokoroSpeakCurrent(appEl, voiceId, attempt + 1);
        }, KOKORO_RETRY_BACKOFF_MS);
        return;
      }
      // Retries exhausted -- give up on this sentence, not on Kokoro. Kept
      // only so kokoroWarmUp() (a background convenience, unrelated to
      // Listen's own voice choice) doesn't keep hammering a broken load.
      this.plugin.kokoroFailed = true;
      this.pausePlayback();
      new Notice('The voice stopped. Press play to try again.');
    };
    // Fast start: a long sentence that isn't made yet (the usual first press
    // of Play) is spoken as its opening words, then the rest, so the voice
    // starts after ~1 s instead of the ~4-5 s a whole sentence takes to make.
    const split = this.plugin.kokoroCache && this.plugin.kokoroCache.has(this.plugin.kokoroKey(text, voiceId)) ? null : this.kokoroSplit(text);
    // The timer starts once the voice model is loaded: the first-ever
    // download can take minutes and isn't a stall.
    const timed = (t) => (this.plugin.kokoroTts ? Promise.resolve() : this.plugin.kokoroLoad())
      .then(() => withKokoroTimeout(this.kokoroAudioFor(t, voiceId), kokoroTimeoutFor(t)));
    if (split) {
      const [headJob, tailJob] = split.map(timed);
      tailJob.catch(() => {}); // reported through failed() when it's needed
      headJob.then((head) => {
        if (!stillCurrent()) return;
        this.plugin.kokoroFailed = false;
        // Queue the next sentences now (behind the rest of this one), so
        // the second sentence is ready when this one ends.
        this.kokoroPrefetch(r, myIndex, voiceId);
        this.kokoroPlay(head, {
          onstart: () => { this.followSentence(myIndex); this.updateListenBarUI(); },
          onend: () => {
            tailJob.then((tail) => {
              if (!stillCurrent()) return;
              this.kokoroPlay(tail, { onstart: () => {}, onend: () => { if (stillCurrent()) this.advanceOrStop(appEl); } });
            }).catch(failed);
          },
        });
      }).catch(failed);
      return;
    }
    timed(text).then((audio) => {
      if (!stillCurrent()) return;
      this.plugin.kokoroFailed = false;
      this.kokoroPrefetch(r, myIndex, voiceId);
      const info = r.format === 'pdf' && r.tts.sentenceInfo ? r.tts.sentenceInfo[myIndex] : null;
      this.kokoroPlay(audio, {
        onstart: () => { this.followSentence(myIndex); this.updateListenBarUI(); },
        onend: () => { if (stillCurrent()) this.advanceOrStop(appEl); },
        // No word timings from Kokoro: turn a split PDF sentence's page at
        // the matching fraction of its audio instead.
        midFraction: info && info.breakAt !== null ? info.breakAt / text.length : null,
        onmid: () => { if (stillCurrent()) this.pdfFollowSentence(myIndex, 'end', appEl); },
      });
    }).catch(failed);
  }

  // [opening words, rest] for a sentence of 12+ words: split after the first
  // comma/semicolon/colon/dash between words 4 and 12, else after word 8.
  kokoroSplit(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 12) return null;
    let cut = words.findIndex((w, i) => i >= 3 && i <= 11 && /[,;:—–]$/.test(w));
    if (cut === -1) cut = 7;
    const head = words.slice(0, cut + 1).join(' ');
    const tail = words.slice(cut + 1).join(' ');
    return head && tail ? [head, tail] : null;
  }

  kokoroPlay(audio, { onstart, onend, midFraction, onmid }) {
    const plugin = this.plugin;
    if (!plugin.kokoroAudioCtx) plugin.kokoroAudioCtx = new AudioContext();
    const ctx = plugin.kokoroAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const buffer = ctx.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buffer.copyToChannel(audio.audio, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (this.kokoroSource !== src) return; // stopped by pause/jump, not finished
      this.kokoroSource = null;
      window.clearTimeout(this.kokoroMidTimer);
      onend();
    };
    this.kokoroSource = src;
    src.start();
    onstart();
    if (Number.isFinite(midFraction) && midFraction > 0) {
      this.kokoroMidTimer = window.setTimeout(onmid, buffer.duration * midFraction * 1000);
    }
  }

  kokoroStopAudio() {
    this.kokoroToken = (this.kokoroToken || 0) + 1;
    window.clearTimeout(this.kokoroMidTimer);
    const src = this.kokoroSource;
    this.kokoroSource = null;
    if (src) { try { src.stop(); } catch { /* not started */ } }
  }

  // ==================== LISTEN — PDF ====================
  // Same Listen bar and voice machinery as EPUB. The text comes from PDF.js
  // (page by page, joined so a sentence split across a page break reads as
  // one), minus running headers/footers and page numbers. Pages load a few
  // at a time as the voice moves on, so a long book doesn't stall on Play.

  pdfTextLineKey(text) {
    return String(text || '').replace(/\d+/g, '#').replace(/\s+/g, '').toLowerCase();
  }

  // Text lines in the top and bottom 10% of a page (where running headers,
  // footers and page numbers live), grouped by baseline.
  pdfEdgeLines(textContent, page) {
    const [, y0, , y1] = page.view;
    const h = (y1 - y0) || 1;
    const lines = new Map();
    for (const item of textContent.items) {
      if (typeof item.str !== 'string' || !item.transform) continue;
      const y = item.transform[5] - y0;
      if (y > h * 0.1 && y < h * 0.9) continue;
      const key = Math.round(y);
      if (!lines.has(key)) lines.set(key, { items: [], text: '' });
      const line = lines.get(key);
      line.items.push(item);
      line.text += `${item.str} `;
    }
    return [...lines.values()];
  }

  // Which edge lines repeat across the book (digits ignored, so "... 2" and
  // "... 3" match). Sampled from up to 20 pages spread through the file;
  // a line has to appear on at least half of them (and 3+) to count, so a
  // one-off heading near the top of a page is never skipped.
  //
  // QA fix v0.17.3: printed books often put the book's title on left-hand
  // pages only and the chapter's on right-hand ones, so each is on just half
  // the pages. Pages are sampled in facing pairs, and a line also counts
  // when it is on at least half of the left-hand (or right-hand) pages.
  async pdfRepeatedEdgeLines(r) {
    if (r.pdf.listenEdgeKeys) return r.pdf.listenEdgeKeys;
    const doc = r.pdf.doc;
    const n = doc.numPages;
    const pairs = Math.min(Math.ceil(n / 2), 10);
    const sample = [...new Set(Array.from({ length: pairs }, (_, i) => 1 + Math.floor((i * n) / pairs))
      .flatMap((p) => [p, p + 1]).filter((p) => p <= n))];
    const counts = new Map(); // key -> [on odd pages, on even pages]
    for (const p of sample) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const keys = new Set(this.pdfEdgeLines(tc, page).map((l) => this.pdfTextLineKey(l.text)).filter(Boolean));
      for (const k of keys) {
        if (!counts.has(k)) counts.set(k, [0, 0]);
        counts.get(k)[p % 2] += 1;
      }
    }
    const sampled = [sample.filter((p) => p % 2 === 0).length, sample.filter((p) => p % 2 === 1).length];
    const repeats = ([even, odd]) => even + odd >= 3 && (
      even + odd >= Math.ceil(sample.length * 0.5)
      || (sampled[0] >= 3 && even >= Math.ceil(sampled[0] * 0.5))
      || (sampled[1] >= 3 && odd >= Math.ceil(sampled[1] * 0.5)));
    r.pdf.listenEdgeKeys = new Set([...counts].filter(([, c]) => repeats(c)).map(([k]) => k));
    return r.pdf.listenEdgeKeys;
  }

  // One page's readable text. map[i] is the character's position among the
  // page's non-space characters (-1 for spaces) -- the same count the
  // on-screen text layer produces, which is how a sentence finds its words
  // on screen (see pdfNwRange).
  async pdfPageListenText(r, p, edgeKeys) {
    const page = await r.pdf.doc.getPage(p);
    const tc = await page.getTextContent();
    const skip = new Set();
    for (const line of this.pdfEdgeLines(tc, page)) {
      const isPageNumber = /^\s*(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?\s*$/i.test(line.text);
      if (isPageNumber || edgeKeys.has(this.pdfTextLineKey(line.text))) line.items.forEach((it) => skip.add(it));
    }
    let text = '';
    const map = [];
    let nw = 0;
    for (const item of tc.items) {
      if (typeof item.str !== 'string') continue;
      const keep = !skip.has(item);
      for (let i = 0; i < item.str.length; i++) {
        const ch = item.str[i];
        const isSpace = /\s/.test(ch);
        if (keep) { text += ch; map.push(isSpace ? -1 : nw); }
        if (!isSpace) nw += 1;
      }
      if (keep && item.hasEOL) { text += ' '; map.push(-1); }
    }
    return { text, map };
  }

  // Adds up to `count` more pages to the listening text and re-splits it.
  // Sentence numbering stays stable for everything already read (the split
  // is deterministic on the same prefix); only the last sentence or two can
  // change as the next page arrives, which is why pdfEnsureSentence keeps
  // two sentences of lookahead.
  pdfExtendListenText(r, count) {
    // One extension at a time per book text, so pages always append in order.
    const m = r.tts.model;
    const run = (m.queue || Promise.resolve()).then(() => this.pdfExtendListenTextNow(r, m, count));
    m.queue = run.catch(() => {});
    return run;
  }

  async pdfExtendListenTextNow(r, m, count) {
    const tts = r.tts;
    const edgeKeys = await this.pdfRepeatedEdgeLines(r);
    let added = 0;
    while (added < count && m.nextPage <= r.pdf.pageCount) {
      const p = m.nextPage;
      m.nextPage += 1;
      added += 1;
      const pt = await this.pdfPageListenText(r, p, edgeKeys);
      if (!pt.text.trim()) { m.emptyPages.add(p); continue; }
      if (m.text && !/\s$/.test(m.text)) { m.text += ' '; m.map.push(-1); }
      m.text += pt.text;
      for (const v of pt.map) m.map.push(v < 0 ? -1 : p * 1e6 + v);
    }
    m.done = m.nextPage > r.pdf.pageCount;
    if (tts.model !== m) return; // superseded by a restart from another page
    const sentences = splitIntoSentences(m.text);
    tts.sentenceTexts = sentences.map((x) => x.text);
    tts.sentenceEls = new Array(sentences.length).fill(null);
    tts.sentenceInfo = sentences.map((x) => {
      const info = { startPage: null, endPage: null, startNW: null, breakAt: null, start: x.start, end: x.end };
      for (let i = x.start; i < x.end; i++) {
        const v = m.map[i];
        if (v < 0 || v === undefined) continue;
        const pg = Math.floor(v / 1e6);
        if (info.startPage === null) { info.startPage = pg; info.startNW = v % 1e6; }
        if (info.endPage !== null && pg !== info.endPage && info.breakAt === null) info.breakAt = i - x.start;
        info.endPage = pg;
      }
      return info;
    });
  }

  async pdfResetListenText(r, fromPage) {
    r.tts.model = { startPage: fromPage, nextPage: fromPage, text: '', map: [], emptyPages: new Set(), done: false, noticed: new Set() };
    r.tts.currentIndex = -1;
    await this.pdfExtendListenText(r, 3);
  }

  // Makes sure sentence idx exists and is final (two sentences of lookahead,
  // or the whole rest of the book is loaded).
  async pdfEnsureSentence(r, idx) {
    const tts = r.tts;
    while (tts.model && !tts.model.done && idx >= tts.sentenceTexts.length - 2) {
      await this.pdfExtendListenText(r, 3);
      if (this.reader !== r) return;
    }
  }

  // First sentence (index) that STARTS on or after `page`, loading more
  // pages as needed. Returns -1 when there is no more text in the book.
  async pdfFirstSentenceFromPage(r, page) {
    const tts = r.tts;
    for (;;) {
      const idx = tts.sentenceInfo.findIndex((x) => x.startPage !== null && x.startPage >= page);
      if (idx !== -1) { await this.pdfEnsureSentence(r, idx); return idx; }
      if (tts.model.done || this.reader !== r) return -1;
      await this.pdfExtendListenText(r, 3);
    }
  }

  // Called after every PDF page render: set up the Listen state once per
  // book, then redraw the current sentence's marker on this page.
  pdfListenAfterRender(box, r, appEl) {
    if (!r.listenBar) return;
    if (!r.tts) {
      r.tts = {
        playing: false, paused: false, currentIndex: -1, chapterLabel: '', stopAfterChapter: false, keepAliveTimer: null,
        sentenceEls: [], sentenceTexts: [], sentenceInfo: [], utterance: null, model: null, loading: true,
      };
      const from = Math.max(1, r.pdf.page - 1);
      this.pdfResetListenText(r, from).then(async () => {
        // A book whose first pages are scans: keep looking for text.
        while (this.reader === r && !r.tts.sentenceTexts.length && !r.tts.model.done) await this.pdfExtendListenText(r, 3);
      }).catch((err) => console.error('Reading Vault: could not read PDF text for Listen', err)).finally(() => {
        if (this.reader !== r) return;
        r.tts.loading = false;
        this.updateListenBarUI();
      });
    }
    this.drawPdfListenMark(box, r);
    this.updateListenBarUI();
  }

  pdfUpdateListenNow(lb, tts) {
    const r = this.reader;
    const loading = !tts || tts.loading;
    const has = !!(tts && tts.sentenceTexts.length);
    lb.playBtn.disabled = !has;
    lb.backBtn.disabled = !has;
    lb.fwdBtn.disabled = !has;
    const pageLabel = r.pdf.pageCount ? `Page ${r.pdf.page} of ${r.pdf.pageCount}` : `Page ${r.pdf.page}`;
    const info = tts && tts.currentIndex >= 0 ? tts.sentenceInfo[tts.currentIndex] : null;
    if (info && tts.sentenceTexts[tts.currentIndex]) {
      // "Time left on this page" and a meter across this page's sentences.
      const onPage = tts.sentenceInfo.map((x, i) => i).filter((i) => tts.sentenceInfo[i].startPage === info.startPage);
      const rest = onPage.filter((i) => i >= tts.currentIndex).map((i) => tts.sentenceTexts[i]).join(' ');
      const words = rest.split(/\s+/).filter(Boolean).length;
      const mins = Math.max(1, Math.round(words / (155 * (this.plugin.settings.ttsSpeed || 1))));
      lb.chapEl.setText(`${pageLabel} · ${mins} min left on page`);
      lb.sentEl.setText(tts.sentenceTexts[tts.currentIndex]);
      const pos = onPage.indexOf(tts.currentIndex);
      lb.meterFill.style.width = `${onPage.length ? Math.min(100, ((pos + 1) / onPage.length) * 100) : 0}%`;
    } else {
      lb.chapEl.setText(pageLabel);
      lb.sentEl.setText(loading ? 'Loading…' : (has ? 'Press play to listen from this page.' : 'This PDF has no text to read aloud (scanned pages).'));
      lb.meterFill.style.width = '0%';
    }
  }

  async pdfOnPlayButtonClick(appEl) {
    const r = this.reader;
    const tts = r && r.tts;
    if (!tts || !tts.model) return;
    if (tts.playing) { this.pausePlayback(); return; }
    if (tts.paused && tts.currentIndex >= 0) { this.resumePlayback(appEl); return; }
    const page = r.pdf.page;
    const from = Math.max(1, page - 1);
    // Start one page back so a sentence that began on the previous page
    // isn't read as a fragment (it's skipped, the same as EPUB's "first
    // sentence starting on this page").
    if (tts.model.startPage > from || page >= tts.model.nextPage) await this.pdfResetListenText(r, from);
    if (this.reader !== r) return;
    let idx = await this.pdfFirstSentenceFromPage(r, page);
    // Resume where the voice stopped, if that was on this page.
    const m = /^page:(\d+):nw:(\d+)$/.exec(String(this.store.getFm(this.currentBook).listen_pos || ''));
    if (m && parseInt(m[1], 10) === page) {
      const nw = parseInt(m[2], 10);
      const at = tts.sentenceInfo.findIndex((x) => x.startPage === page && x.startNW >= nw);
      if (at > idx) { idx = at; new Notice('Resuming from where the voice stopped.'); }
    }
    if (idx < 0) { new Notice('No more text to read in this PDF.'); return; }
    this.pdfPlayFrom(idx, appEl);
  }

  async pdfPlayFrom(idx, appEl) {
    const r = this.reader;
    if (!r || !r.tts || !r.tts.model) return;
    r.followScroll = true; // tapping a sentence or pressing play resumes auto-scroll
    await this.pdfEnsureSentence(r, idx);
    if (this.reader !== r) return;
    const tts = r.tts;
    if (!tts.sentenceTexts.length) return;
    idx = Math.max(0, Math.min(tts.sentenceTexts.length - 1, idx));
    tts.currentIndex = idx;
    tts.playing = true;
    tts.paused = false;
    this.plugin.sessionRecorder.noteActivity(this.bookInfo(), 'listen', 0);
    this.pdfFollowSentence(idx, 'start', appEl);
    this.speakCurrentSentence(appEl);
    this.saveListenPosition();
    this.updateListenBarUI();
  }

  async pdfAdvance(appEl) {
    const r = this.reader;
    if (!r || !r.tts) return;
    const tts = r.tts;
    const cur = tts.sentenceInfo[tts.currentIndex];
    const next = tts.currentIndex + 1;
    await this.pdfEnsureSentence(r, next);
    if (this.reader !== r || !tts.playing) return;
    const ni = tts.sentenceInfo[next];
    // "Stop after page": finish the page the current sentence started on
    // (including a sentence that spills onto the next page), then stop.
    if (!ni || (tts.stopAfterChapter && cur && ni.startPage > cur.startPage)) {
      this.stopPlayback();
      this.updateListenBarUI();
      return;
    }
    tts.currentIndex = next;
    this.pdfFollowSentence(next, 'start', appEl);
    this.speakCurrentSentence(appEl);
    this.saveListenPosition();
    this.updateListenBarUI();
  }

  // Keep the page with the voice: show the page a sentence starts on, and
  // (pdfTurnMidSentence) turn when the voice reaches the part of a split
  // sentence that is on the next page. Pages with no text in between get a
  // one-line notice.
  pdfFollowSentence(idx, which, appEl) {
    const r = this.reader;
    const info = r && r.tts && r.tts.sentenceInfo[idx];
    if (!info) return;
    const target = which === 'end' ? info.endPage : info.startPage;
    if (!target || target === r.pdf.page) { this.pdfRedrawListenMark(); return; }
    // Never pull the page out from under a selection being made.
    const sel = window.getSelection();
    const box = this.containerEl.querySelector('.a4r-pdf-box');
    if (sel && sel.rangeCount && !sel.isCollapsed && box && box.contains(sel.anchorNode)) return;
    const skipped = [];
    for (let p = Math.min(r.pdf.page, target) + 1; p < Math.max(r.pdf.page, target); p++) {
      if (r.tts.model.emptyPages.has(p) && !r.tts.model.noticed.has(p)) { skipped.push(p); r.tts.model.noticed.add(p); }
    }
    if (skipped.length) {
      new Notice(skipped.length === 1
        ? `Skipped page ${skipped[0]}: no text to read (scanned page).`
        : `Skipped pages ${skipped.join(', ')}: no text to read (scanned pages).`);
    }
    r.pdf.page = target;
    this.scheduleProgressSave();
    this.renderReader(appEl);
  }

  pdfTurnMidSentence(utter, myIndex, appEl) {
    const r = this.reader;
    const info = r.tts.sentenceInfo[myIndex];
    if (!info || info.breakAt === null) return;
    let turned = false;
    utter.onboundary = (ev) => {
      const cur = this.reader;
      if (turned || cur !== r || !r.tts.playing || r.tts.currentIndex !== myIndex) return;
      if (typeof ev.charIndex !== 'number' || ev.charIndex < info.breakAt) return;
      turned = true;
      this.pdfFollowSentence(myIndex, 'end', appEl);
    };
  }

  pdfStopListenOnHandTurn() {
    const r = this.reader;
    if (!r || !r.tts || (!r.tts.playing && !r.tts.paused)) return;
    this.stopPlayback();
    r.tts.currentIndex = -1;
  }

  // epubStopListenOnJump — the epub counterpart of pdfStopListenOnHandTurn(),
  // called by every in-session navigation jump (bookmark, highlight, search
  // result, Contents entry). Two problems fixed by the same one call:
  // (1) a jump landing mid-speech would otherwise leave the voice reading
  // on from the OLD spot underneath the newly-displayed page; (2) with
  // r.tts left in place, rebuildTtsSentences()'s own "was this already
  // playing/paused on this exact chapter" check (`priorPlayingSameChapter`)
  // and the Listen bar's very first paint (buildListenBar() runs and reads
  // r.tts.chapterLabel BEFORE the jump target's own chapter has actually
  // re-rendered) could both go on showing the PREVIOUS chapter's cached
  // r.tts.chapterLabel for a moment -- reported live as the Listen bar
  // stuck on "INTRODUCTION" while the page underneath had already moved on.
  // Nulling r.tts here forces rebuildTtsSentences() to treat the jump
  // target as a genuinely fresh chapter every time: no stale label, no
  // stale currentIndex to (silently) resume from -- Listen starts from
  // whatever page is actually on screen, per the v0.4.5 brief. PDF doesn't
  // need this: its Listen label is built fresh from r.pdf.page on every
  // render (pdfUpdateListenNow), so pdfStopListenOnHandTurn()'s existing
  // "stop the voice, reset the index" is already sufficient there.
  // Turning into another chapter by hand while Listen plays (QA fix
  // v0.17.3): save where the voice actually was, then stop it, so it
  // doesn't keep talking over the new chapter or save a blank position.
  stopListenForHandChapterTurn(r) {
    if (!r || !r.tts || !(r.tts.playing || r.tts.paused)) return;
    this.flushListenPosition();
    this.epubStopListenOnJump(r);
  }

  epubStopListenOnJump(r) {
    if (!r || r.format !== 'epub') return;
    if (r.tts && (r.tts.playing || r.tts.paused)) this.stopPlayback();
    r.tts = null;
  }

  pdfRedrawListenMark() {
    const r = this.reader;
    const box = this.containerEl.querySelector('.a4r-pdf-box');
    if (r && box) this.drawPdfListenMark(box, r);
  }

  // The "being read now" marker: the current sentence's characters on this
  // page, drawn in the highlight layer (same look as EPUB's current
  // sentence).
  drawPdfListenMark(box, r) {
    box.querySelectorAll('.a4r-pdf-hl-layer > mark.a4r-pdf-listen').forEach((n) => n.remove());
    const tts = r.tts;
    // Only while actually playing -- paused/stopped should look like a
    // normal PDF page again, same rule as EPUB's clearListenVisuals().
    if (!tts || !tts.playing || tts.currentIndex < 0 || !tts.model) return;
    const info = tts.sentenceInfo[tts.currentIndex];
    if (!info) return;
    let lo = null;
    let hi = null;
    for (let i = info.start; i < info.end; i++) {
      const v = tts.model.map[i];
      if (v < 0 || v === undefined || Math.floor(v / 1e6) !== r.pdf.page) continue;
      const nw = v % 1e6;
      if (lo === null) lo = nw;
      hi = nw;
    }
    if (lo === null) return;
    const textDiv = box.querySelector(':scope > .textLayer');
    const range = textDiv ? this.pdfNwRange(textDiv, lo, hi) : null;
    if (range) {
      this.drawPdfMark(box, range, null, null, 'a4r-pdf-listen');
      this.followScrollToSentence(box.querySelector('.a4r-pdf-hl-layer > mark.a4r-pdf-listen'));
    }
  }

  // Range from the lo-th to the hi-th non-space character of the page's
  // text layer (inclusive).
  pdfNwRange(root, lo, hi) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = 0;
    let start = null;
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) continue;
        if (n === lo) start = [node, i];
        if (n === hi && start) {
          const range = document.createRange();
          range.setStart(start[0], start[1]);
          range.setEnd(node, i + 1);
          return range;
        }
        n += 1;
      }
    }
    return null;
  }

  // Draws the mark FIRST, synchronously, off data already in memory (the
  // range/DOM position never depends on the highlight note actually
  // existing on disk yet) and only awaits `store.createHighlight()` in the
  // background to attach the real file path once it resolves. Previously
  // the mark was drawn only after awaiting the file write -- normally fast,
  // but any main-thread contention (e.g. the frontmatter-write storm from
  // Listen's old progress-saving, see saveListenPosition()) could stall
  // that await long enough to read as "H does nothing for a second or two."
  // This makes the visible highlight independent of that await's timing.
  saveCurrentSentenceAsHighlight(appEl) {
    const r = this.reader;
    if (!r || !r.tts || r.tts.currentIndex < 0 || !r.tts.sentenceTexts.length) return;
    const text = r.tts.sentenceTexts[r.tts.currentIndex];
    if (!text) return;
    const defaultColor = HIGHLIGHT_COLORS[0].hex;
    if (r.format === 'pdf') {
      const info = r.tts.sentenceInfo[r.tts.currentIndex];
      const excerpt = text.replace(/\s+/g, ' ');
      const page = info ? info.startPage : r.pdf.page;
      const box = this.containerEl.querySelector('.a4r-pdf-box');
      const textDiv = box && box.querySelector(':scope > .textLayer');
      const range = textDiv ? this.pdfRangeForHighlight(box, textDiv, excerpt, page, r.pdf.page) : null;
      const mark = range ? this.drawPdfMark(box, range, defaultColor, null) : null;
      new Notice('Highlight saved.');
      if (appEl) this.updateListenBarUI();
      this.store.createHighlight({
        bookFile: this.currentBook, format: 'pdf', locationPage: page, locationCfi: null, excerpt, color: defaultColor,
      }).then((pdfHl) => { if (mark && mark.isConnected) mark.dataset.a4rHighlightPath = pdfHl.path; })
        .catch((err) => console.error('Reading Vault: could not save highlight', err));
      return;
    }
    const el = r.tts.sentenceEls[r.tts.currentIndex];
    let mark = null;
    try {
      if (el && !el.querySelector('mark')) {
        mark = document.createElement('mark');
        mark.style.background = defaultColor;
        while (el.firstChild) mark.appendChild(el.firstChild);
        el.appendChild(mark);
      }
    } catch { /* visual mark is best-effort; the highlight note is still saved below */ }
    new Notice('Highlight saved.');
    if (appEl) this.updateListenBarUI();
    this.store.createHighlight({
      bookFile: this.currentBook, format: 'epub', locationPage: null, locationCfi: this.currentLocationString(r), excerpt: text, color: defaultColor,
    }).then((hlFile) => { if (mark && mark.isConnected) mark.dataset.a4rHighlightPath = hlFile.path; })
      .catch((err) => console.error('Reading Vault: could not save highlight', err));
  }

  wireHighlighting(contentHost, r, appEl) {
    // Where/when the press started, so the sentence click handler can tell a
    // real click apart from the end of a drag-selection.
    contentHost.addEventListener('mousedown', (ev) => {
      contentHost._a4rPointerDown = { x: ev.clientX, y: ev.clientY, t: Date.now() };
    });
    contentHost.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const text = sel.toString().trim();
      if (!text || text.length > 10000) return;
      if (!contentHost.contains(sel.anchorNode)) return;
      const range = sel.getRangeAt(0);
      const rect = this.visibleRangeRect(range);
      // Dragging a selection pauses the voice (Listen feature) — it resumes
      // from the same sentence once this color popup closes, whether the
      // selection became a highlight or was just dismissed.
      const wasPlaying = !!(r.tts && r.tts.playing);
      if (wasPlaying) this.pausePlayback();
      const lookupWord = lookupWordFrom(text);
      const lookup = lookupWord ? { word: lookupWord, sentence: this.lookupSentence(range, lookupWord), r } : null;
      this.showColorPopup(rect, async (color) => {
        // PDF text-layer selections carry line breaks between text runs;
        // store one clean line so triage cards read naturally.
        const excerpt = r.format === 'pdf' ? text.replace(/\s+/g, ' ') : text;
        let locationCfi = null; let locationPage = null;
        if (r.format === 'epub') locationCfi = this.currentLocationString(r);
        else locationPage = r.pdf.page;
        const hlFile = await this.store.createHighlight({
          bookFile: this.currentBook, format: r.format, locationPage, locationCfi, excerpt, color,
        });
        try {
          if (r.format === 'pdf') this.drawPdfMark(contentHost, range, color, hlFile);
          else this.wrapRangeInMark(range, color, hlFile);
        } catch { /* selection spans an awkward boundary — data is still saved, redraw will catch it */ }
        sel.removeAllRanges();
        new Notice('Highlight saved.');
      }, () => {
        if (wasPlaying) this.resumePlayback(appEl);
      }, lookup);
    });

    // Click-to-open on any highlight <mark> — both ones just created above
    // and ones redrawn by drawSavedHighlights() on chapter open. Delegated
    // so it keeps working after re-renders without rewiring.
    contentHost.addEventListener('click', (e) => {
      // PDF highlights sit UNDER the selectable text layer (so they never
      // block selecting), so a click lands on text -- find the mark by point.
      const markEl = e.target.closest('mark') || (r.format === 'pdf' ? this.pdfMarkAt(contentHost, e.clientX, e.clientY) : null);
      if (!markEl || !contentHost.contains(markEl)) return;
      const hlPath = markEl.dataset.a4rHighlightPath;
      if (!hlPath) return;
      const hlFile = this.app.vault.getAbstractFileByPath(hlPath);
      if (!hlFile) return;
      const fm = this.store.getFm(hlFile);
      const rect = markEl.getBoundingClientRect();
      this.showHighlightActionsPopup(rect, hlFile, fm.color, appEl);
    });
  }

  // Opens on a click on an existing highlight: recolor (reuses the same
  // swatch palette as the creation popup), edit its note, or delete.
  // Re-renders the reader afterward so the <mark> reflects any change
  // immediately. Swatch clicks keep their existing instant-save-and-close
  // behavior unchanged; the Note field below is edited and saved
  // independently via its own Save button -- picking a color and writing a
  // note happen as two separate actions (reopen the popup after picking a
  // color to add a note), not both in the same click, to avoid the note
  // textarea's in-progress text being silently discarded by a swatch click.
  showHighlightActionsPopup(rect, hlFile, currentColor, appEl) {
    const popup = this.openHighlightPopup(rect, { closeOnDeselect: false });
    const swatchRow = popup.createDiv({ cls: 'a4r-hl-swatch-row' });
    for (const c of HIGHLIGHT_COLORS) {
      const btn = swatchRow.createEl('button', { cls: 'a4r-swatch-btn' });
      setTooltip(btn, c.label);
      btn.style.background = c.hex;
      if (c.hex === currentColor) btn.style.outline = '2px solid var(--text-normal)';
      btn.onclick = async () => {
        this.dismissHighlightPopup();
        await this.store.updateColor(hlFile, c.hex);
        this.refreshHighlightMarks(hlFile.path, { color: c.hex });
      };
    }
    popup.createDiv({ cls: 'a4r-hl-note-label', text: 'Note' });
    const noteArea = popup.createEl('textarea', { cls: 'a4r-hl-note-textarea' });
    noteArea.value = this.store.getFm(hlFile).note || '';
    // The popup's own mousedown handler calls preventDefault (so picking a
    // color doesn't clear the text selection it's about to save) -- that
    // would also block the textarea from ever taking focus/caret placement.
    // Stop it from bubbling out of the textarea specifically.
    noteArea.addEventListener('mousedown', (e) => e.stopPropagation());
    const actionsRow = popup.createDiv({ cls: 'a4r-hl-popup-actions' });
    const delBtn = actionsRow.createEl('button', { cls: 'a4r-hl-delete', text: 'Delete' });
    delBtn.onclick = async () => {
      this.dismissHighlightPopup();
      const path = hlFile.path;
      await this.store.deleteHighlight(hlFile);
      this.refreshHighlightMarks(path, { remove: true });
    };
    const saveBtn = actionsRow.createEl('button', { cls: 'a4r-btn-primary', text: 'Save note' });
    saveBtn.onclick = async () => {
      this.dismissHighlightPopup();
      await this.store.setHighlightNote(hlFile, noteArea.value);
      this.refreshHighlightMarks(hlFile.path, { note: noteArea.value });
    };
    this.placeHighlightPopup(popup, rect);
  }

  // Shows a highlight's new color or note (or its removal) on the page
  // right away (QA fix v0.17.3). A full redraw would read the highlight
  // back before Obsidian has caught up with the change, and show the old
  // one until the next page turn.
  refreshHighlightMarks(path, { color, note, remove } = {}) {
    const root = this.containerEl;
    const marks = Array.from(root.querySelectorAll('mark')).filter((m) => m.dataset.a4rHighlightPath === path);
    for (const mark of marks) {
      const pdf = mark.querySelector(':scope > .a4r-pdf-hl-part');
      if (remove) {
        if (pdf) { mark.remove(); continue; }
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        mark.remove();
        if (parent && parent.normalize) parent.normalize();
        continue;
      }
      if (color) {
        if (pdf) mark.querySelectorAll(':scope > .a4r-pdf-hl-part').forEach((part) => { part.style.background = color; });
        else mark.style.background = color;
      }
      if (note !== undefined) mark.classList.toggle('a4r-has-note', !!String(note).trim());
    }
  }

  // lookup (v0.13.0): { word, sentence, r } when the selection is a single
  // word -- adds Look up (or Download dictionary) after the colours.
  showColorPopup(rect, onPick, onClose, lookup) {
    const popup = this.openHighlightPopup(rect, { closeOnDeselect: true, onClose });
    const swatchRow = popup.createDiv({ cls: 'a4r-hl-swatch-row' });
    for (const c of HIGHLIGHT_COLORS) {
      const btn = swatchRow.createEl('button', { cls: 'a4r-swatch-btn' });
      setTooltip(btn, c.label);
      btn.style.background = c.hex;
      // Pick first, then close: closing stops watching the selection, so
      // onPick's own removeAllRanges() can't be mistaken for a dismissal.
      btn.onclick = () => { onPick(c.hex); this.dismissHighlightPopup(); };
    }
    const kind = lookup ? this.lookupButtonKind(lookup.r) : null;
    if (kind) {
      popup.addClass('a4r-hl-has-lookup');
      swatchRow.createDiv({ cls: 'a4r-hl-swatch-sep' });
      const btn = swatchRow.createEl('button', { cls: 'a4r-lookup-open', text: kind === 'lookup' ? 'Look up' : 'Download dictionary' });
      if (kind === 'download') setTooltip(btn, 'Opens Settings → Word lookup');
      btn.onclick = () => {
        if (kind === 'download') { this.dismissHighlightPopup(); this.plugin.openOwnSettings(); return; }
        // Swap the colour pop-up for the card without resuming Listen yet;
        // that happens when the card itself closes.
        this.dismissHighlightPopup({ quiet: true });
        this.openLookupCard(rect, { ...lookup, onClose });
      };
    }
    this.placeHighlightPopup(popup, rect);
  }

  // One highlight popup at a time. It closes on a click outside it, Escape,
  // a page turn/re-render (see renderReader), and -- for the new-highlight
  // picker -- when the text selection it belongs to goes away.
  openHighlightPopup(rect, { closeOnDeselect, onClose }) {
    this.dismissHighlightPopup();
    // In full screen only the book is on screen, so the pop-up goes there.
    const popup = (document.fullscreenElement || document.body).createDiv({ cls: 'a4r-hl-color-popup' });
    // Clicking a swatch must not clear the selection it is about to save.
    popup.addEventListener('mousedown', (e) => e.preventDefault());
    const onOutside = (e) => { if (!popup.contains(e.target)) this.dismissHighlightPopup(); };
    const onKey = (e) => { if (e.key === 'Escape') this.dismissHighlightPopup(); };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this.dismissHighlightPopup();
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      if (closeOnDeselect) document.addEventListener('selectionchange', onSelChange);
    }, 0);
    document.addEventListener('keydown', onKey, true);
    // quiet: closed by a re-render/page turn -- skip onClose, which resumes
    // the Listen voice against the chapter DOM that is being replaced.
    this.hlPopupClose = (quiet) => {
      this.hlPopupClose = null;
      window.clearTimeout(timer);
      popup.remove();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('keydown', onKey, true);
      if (onClose && !quiet) onClose();
    };
    return popup;
  }

  dismissHighlightPopup({ quiet = false } = {}) {
    if (this.hlPopupClose) this.hlPopupClose(quiet);
    document.querySelectorAll('.a4r-hl-color-popup').forEach((n) => n.remove());
  }

  // Just above the passage, never on top of it; below it when there is no
  // room above; kept inside the window.
  placeHighlightPopup(popup, rect) {
    const gap = 8;
    const h = popup.offsetHeight;
    const w = popup.offsetWidth;
    let top = rect.top - h - gap;
    if (top < gap) top = rect.bottom + gap;
    top = Math.max(gap, Math.min(top, window.innerHeight - h - gap));
    const left = Math.max(gap, Math.min(rect.left, window.innerWidth - w - gap));
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }

  // The selection's box from the selected characters only. A drag that
  // starts past the end of the line above picks up that line's trailing
  // space/line break, which getBoundingClientRect() counts -- that put the
  // picker a line too high, on top of the text being selected.
  visibleRangeRect(range) {
    const rootNode = range.commonAncestorContainer;
    const walker = document.createTreeWalker(rootNode.nodeType === Node.TEXT_NODE ? rootNode.parentNode : rootNode, NodeFilter.SHOW_TEXT);
    let box = null;
    let node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (!node.nodeValue.slice(start, end).trim()) continue;
      const sub = document.createRange();
      sub.setStart(node, start);
      sub.setEnd(node, end);
      for (const b of Array.from(sub.getClientRects())) {
        if (b.width < 1 || b.height < 1) continue;
        box = box
          ? { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) }
          : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      }
    }
    if (!box) return range.getBoundingClientRect();
    return { ...box, width: box.right - box.left, height: box.bottom - box.top };
  }

  // The re-render right after a dismiss reads frontmatter before Obsidian's
  // metadata cache has caught up, so the highlight still looked "pending"
  // and stayed on screen. Remember this session's dismissals and apply them
  // on top of whatever the cache says.
  // Linking has the same race: the just-linked highlight still read as
  // "pending", got picked as the active one, and the screen showed its
  // relink panel instead of "Nothing left to review".
  async dismissTriageHighlight(hlFile) {
    await this.store.setDismissed(hlFile, true);
    this.setLocalHighlightStatus(hlFile, 'dismissed');
  }

  setLocalHighlightStatus(hlFile, status) {
    if (!this.hlLocalStatus) this.hlLocalStatus = new Map();
    if (status) this.hlLocalStatus.set(hlFile.path, status); else this.hlLocalStatus.delete(hlFile.path);
  }

  withLocalDismissals(highlights) {
    if (!this.hlLocalStatus || !this.hlLocalStatus.size) return highlights;
    return highlights.map((h) => (this.hlLocalStatus.has(h.file.path) ? { ...h, status: this.hlLocalStatus.get(h.file.path) } : h));
  }

  // ==================== HIGHLIGHTS TRIAGE ====================
  // Book-scoped triage queue — matches John's real A3 Highlights screen:
  // entered from a specific open book (same as Detail/Reader), with a header
  // showing that book's cover/title/author, then a "N to review" queue of
  // just that book's pending highlights (click a row to make it active on
  // the right, same list-on-the-left/detail-on-the-right shape as before —
  // just no longer cross-book).
  renderHighlights(body) {
    if (!this.currentBook) { this.renderHighlightsGlobal(body); return; }
    const file = this.currentBook;
    const fm = this.store.getFm(file);

    const header = body.createDiv({ cls: 'a4r-hl-triage-header' });
    const coverEl = header.createDiv({ cls: 'a4r-mini-cover' });
    if (fm.cover_path) {
      const img = coverEl.createEl('img');
      img.src = this.app.vault.adapter.getResourcePath(fm.cover_path);
    } else {
      const [bg, fg] = pickPlaceholderColor(fm.title || '');
      coverEl.style.background = bg; coverEl.style.color = fg;
    }
    const headerText = header.createDiv();
    headerText.createDiv({ cls: 'a4r-hl-h', text: 'HIGHLIGHTS IN THIS BOOK' });
    headerText.createDiv({
      cls: 'a4r-hl-triage-title',
      text: fm.author ? `${fm.title || file.basename} · ${fm.author}` : (fm.title || file.basename),
    });

    const all = this.withLocalDismissals(this.store.listHighlights(file.path));
    const pending = all.filter((h) => h.status === 'pending');
    const handled = all.length - pending.length;

    body.createDiv({ cls: 'a4r-hl-triage-sub', text: `${pending.length} to review${handled ? ` · ${handled} already handled` : ''} · dismiss ones you'll skip` });

    if (!pending.length && !all.length) {
      body.createDiv({ cls: 'a4r-empty-state', text: 'Nothing waiting to be linked. New highlights you make in the Reader will show up here.' });
      return;
    }

    // Keep the previously-active highlight selected across re-renders (e.g.
    // after dismissing a different row); fall back to the first pending item
    // if the remembered one is gone (linked/dismissed/deleted).
    // Search the full list (pending + linked) so a previously-selected
    // linked highlight stays selected across re-renders too — not just
    // pending ones. Fall back to the first pending item only when nothing
    // remembered matches anything in the list at all.
    // Dismissed highlights leave the queue (they still count as "handled").
    const shown = all.filter((h) => h.status !== 'dismissed');
    let current = shown.find((h) => h.file.path === this.hlActiveHighlightPath);
    if (!current) { current = pending[0]; this.hlActiveHighlightPath = current ? current.file.path : null; }

    const grid = body.createDiv({ cls: 'a4r-hl-triage a4r-hl-triage-queue' });

    const left = grid.createDiv({ cls: 'a4r-hl-triage-left a4r-hl-queue-list' });
    // Render every highlight in the book, not just the pending ones — the
    // sub-header already counts both ("N to review · M already handled"),
    // so the list below it must show both too. Already-linked highlights
    // render muted with their resolved topic, matching the Detail screen's
    // "→ mindfulness" treatment, but are still clickable to view their
    // detail in the right panel — they just get no dismiss button (dismiss
    // doesn't make sense for something already linked).
    for (const h of shown) {
      const isLinked = h.status === 'linked';
      const row = left.createDiv({
        cls: `a4r-hl-queue-row${current && h.file.path === current.file.path ? ' is-active' : ''}${isLinked ? ' a4r-hl-queue-row-handled' : ''}`,
      });
      if (h.format === 'pdf') {
        row.createDiv({ cls: 'a4r-loc', text: `PDF page ${h.location_page ?? '—'}` });
      }
      row.createDiv({ cls: 'a4r-hl-queue-excerpt', text: `"${truncate(h.excerpt, 90)}"` });
      if (isLinked) {
        row.createDiv({
          cls: 'a4r-topic-link',
          text: `→ ${h.topic_path ? h.topic_path.split('/').pop().replace(/\.md$/, '') : (h.topic_slug || 'linked')}`,
        });
        row.onclick = () => { this.hlActiveHighlightPath = h.file.path; this.render(); };
        continue;
      }
      row.onclick = () => { this.hlActiveHighlightPath = h.file.path; this.render(); };
      const dismissBtn = row.createEl('button', { cls: 'a4r-hl-queue-dismiss', text: '✕', attr: { 'aria-label': 'Dismiss this highlight' } });
      dismissBtn.onclick = async (e) => {
        e.stopPropagation();
        await this.dismissTriageHighlight(h.file);
        if (this.hlActiveHighlightPath === h.file.path) this.hlActiveHighlightPath = null;
        this.render();
      };
    }

    if (!current) {
      // Nothing left to list (all dismissed): drop the empty box so the
      // message centres across the whole width (see .a4r-hl-triage CSS).
      if (!shown.length) left.remove();
      // Everything in this book is already handled (linked/dismissed) — the
      // list above still shows every highlight, just nothing needs triage,
      // so there's no right-hand link panel to show.
      grid.createDiv({ cls: 'a4r-empty-state', text: 'Nothing left to review — every highlight in this book has been linked or dismissed.' });
      return;
    }

    grid.createDiv({ cls: 'a4r-hl-triage-arrow', text: '→' });

    const right = grid.createDiv({ cls: 'a4r-hl-triage-right' });
    if (current.format === 'pdf') {
      right.createDiv({ cls: 'a4r-loc', text: `PDF page ${current.location_page ?? '—'}` });
    }
    right.createDiv({ cls: 'a4r-quote', text: `"${current.excerpt}"` });
    this.renderHighlightLinkPanel(right, current);
  }

  // Renders a book-badge (cover thumbnail, or a text badge when no cover art
  // is available) for one highlight row/panel, so a mixed-book list always
  // shows which book a highlight came from.
  renderHighlightBookBadge(host, h) {
    const bookFile = h.book_path ? this.app.vault.getAbstractFileByPath(h.book_path) : null;
    const bookFm = bookFile ? this.store.getFm(bookFile) : {};
    const coverPath = bookFm.cover_path;
    const label = h.book_title || (bookFile ? bookFile.basename : 'Unknown book');
    if (coverPath) {
      const thumb = host.createDiv({ cls: 'a4r-hl-book-thumb' });
      const img = thumb.createEl('img');
      img.src = this.app.vault.adapter.getResourcePath(coverPath);
      host.createSpan({ cls: 'a4r-hl-book-badge-text', text: label });
    } else {
      host.createDiv({ cls: 'a4r-hl-book-badge', text: label });
    }
  }

  // Shared right-hand "link to topic / dismiss" panel — used by both the
  // book-scoped triage queue and the global All Highlights queue below, so
  // linking/dismissing always goes through the same store methods
  // (store.linkHighlight / store.setDismissed) regardless of which screen
  // triggered it.
  renderHighlightLinkPanel(right, current) {
    const isLinked = current.status === 'linked';
    if (isLinked) {
      // Already-linked highlight: show what it's linked to (with a click-
      // through to the Topic note) instead of jumping straight to the
      // "pick a topic" picker — but the picker still renders below so this
      // highlight can be relinked to a different topic if needed.
      const topicName = current.topic_path
        ? current.topic_path.split('/').pop().replace(/\.md$/, '')
        : (current.topic_slug || 'a topic');
      const infoBox = right.createDiv({ cls: 'a4r-hl-linked-info' });
      infoBox.createDiv({ cls: 'a4r-hl-linked-label', text: 'Currently linked to:' });
      const topicRow = infoBox.createDiv({ cls: 'a4r-hl-linked-topic' });
      if (current.topic_path) {
        const link = topicRow.createEl('a', { text: topicName, cls: 'a4r-hl-linked-topic-link', href: '#' });
        link.onclick = (e) => {
          e.preventDefault();
          const topicFile = this.app.vault.getAbstractFileByPath(current.topic_path);
          if (topicFile) this.app.workspace.getLeaf(false).openFile(topicFile);
        };
      } else {
        topicRow.setText(topicName);
      }
      right.createDiv({ cls: 'a4r-hl-linked-hint', text: 'Pick a different topic below to relink this highlight.' });
      const unlinkBtn = right.createEl('button', { cls: 'a4r-hl-unlink-btn', text: 'Unlink (send back to unreviewed)' });
      unlinkBtn.onclick = async () => {
        await this.store.unlinkHighlight(current.file);
        this.setLocalHighlightStatus(current.file, 'pending');
        this.hlSelectedTopic = null; this.hlSearchText = '';
        this.hlActiveHighlightPath = null; // fall back to the next pending item
        new Notice('Unlinked — back to unreviewed.');
        this.render();
      };
    }

    const searchBox = right.createDiv({ cls: 'a4r-hl-search-box' });
    const searchInput = searchBox.createEl('input', { attr: { placeholder: 'Search or create a topic…' }, value: this.hlSearchText });

    const allTopics = this.store.listTopicFiles().map((f) => f.basename).sort((a, b) => a.localeCompare(b));
    const hintEl = right.createDiv({ cls: 'a4r-hl-topic-hint' });
    const listEl = right.createDiv({ cls: 'a4r-hl-topic-list' });
    const selectBtn = right.createEl('button', { cls: 'a4r-hl-select-btn', text: isLinked ? 'Select a topic to relink' : 'Select a topic to link' });

    const renderTopicList = () => {
      listEl.empty();
      const q = this.hlSearchText.trim().toLowerCase();
      const matches = q ? allTopics.filter((t) => t.toLowerCase().includes(q)) : allTopics;
      const shown = q ? matches : matches.slice(0, 5);
      hintEl.setText(q
        ? `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${this.hlSearchText.trim()}".`
        : `Your first 5 topics, out of ${allTopics.length} total — type to search all of them.`);
      for (const t of shown) {
        const btn = listEl.createEl('button', { text: t, cls: this.hlSelectedTopic === t ? 'a4r-selected' : '' });
        btn.onclick = () => { this.hlSelectedTopic = t; renderTopicList(); updateSelectBtn(); };
      }
      const exact = allTopics.some((t) => t.toLowerCase() === q);
      if (q && !exact) {
        const createBtn = listEl.createEl('button', {
          text: `+ Create topic "${this.hlSearchText.trim()}"`,
          cls: this.hlSelectedTopic === this.hlSearchText.trim() ? 'a4r-selected' : '',
        });
        createBtn.onclick = () => { this.hlSelectedTopic = this.hlSearchText.trim(); renderTopicList(); updateSelectBtn(); };
      }
    };
    const updateSelectBtn = () => {
      selectBtn.toggleClass('a4r-ready', !!this.hlSelectedTopic);
      selectBtn.disabled = !this.hlSelectedTopic;
    };
    searchInput.oninput = () => { this.hlSearchText = searchInput.value; this.hlSelectedTopic = null; renderTopicList(); updateSelectBtn(); };
    renderTopicList();
    updateSelectBtn();

    selectBtn.onclick = async () => {
      if (!this.hlSelectedTopic) return;
      const linkedTopic = this.hlSelectedTopic;
      await this.store.linkHighlight(current.file, linkedTopic);
      if (!isLinked) this.setLocalHighlightStatus(current.file, 'linked');
      this.hlSelectedTopic = null; this.hlSearchText = '';
      this.hlActiveHighlightPath = null; // fall back to the next pending item
      new Notice(`Linked to "${linkedTopic}".`);
      this.render();
    };

    if (!isLinked) {
      const dismiss = right.createEl('button', { cls: 'a4r-hl-dismiss-link', text: 'Dismiss this highlight (skip it, no topic needed)' });
      dismiss.onclick = async () => {
        await this.dismissTriageHighlight(current.file);
        this.hlActiveHighlightPath = null;
        this.render();
      };
    }
  }

  // ==================== HIGHLIGHTS TRIAGE — GLOBAL (no book open) ====================
  // Reached by clicking the Highlights tab directly from Grid with no book
  // open — matches A3's AllHighlightsView. Same list-on-the-left /
  // detail-on-the-right shape as the book-scoped queue above, but scans
  // every book's highlights instead of one, and shows a small book badge
  // per row so you can tell which book each highlight is from.
  renderHighlightsGlobal(body) {
    const header = body.createDiv({ cls: 'a4r-hl-triage-header' });
    const headerText = header.createDiv();
    headerText.createDiv({ cls: 'a4r-hl-h', text: 'ALL HIGHLIGHTS' });
    headerText.createDiv({ cls: 'a4r-hl-triage-title', text: 'All Highlights' });
    const expAll = header.createEl('button', { cls: 'a4r-export-open', text: '⤓ Export' });
    setTooltip(expAll, 'Export highlights from all your books to a file');
    expAll.onclick = () => this.plugin.openExport(null);

    const all = this.withLocalDismissals(this.store.listHighlights(null));
    const pending = all.filter((h) => h.status === 'pending');
    const handled = all.length - pending.length;

    body.createDiv({ cls: 'a4r-hl-triage-sub', text: `${pending.length} to review${handled ? ` · ${handled} already handled` : ''} · dismiss ones you'll skip` });

    if (!pending.length && !all.length) {
      body.createDiv({ cls: 'a4r-empty-state', text: 'Nothing waiting to be linked. New highlights you make in the Reader will show up here.' });
      return;
    }

    // Search the full list (pending + linked), same fix as the book-scoped
    // triage view above — otherwise a previously-selected linked highlight
    // is never found and the panel silently falls back to a pending one.
    // Dismissed highlights leave the queue (they still count as "handled").
    const shown = all.filter((h) => h.status !== 'dismissed');
    let current = shown.find((h) => h.file.path === this.hlActiveHighlightPath);
    if (!current) { current = pending[0]; this.hlActiveHighlightPath = current ? current.file.path : null; }

    const grid = body.createDiv({ cls: 'a4r-hl-triage a4r-hl-triage-queue' });
    const left = grid.createDiv({ cls: 'a4r-hl-triage-left a4r-hl-queue-list' });

    for (const h of shown) {
      const isLinked = h.status === 'linked';
      const row = left.createDiv({
        cls: `a4r-hl-queue-row${current && h.file.path === current.file.path ? ' is-active' : ''}${isLinked ? ' a4r-hl-queue-row-handled' : ''}`,
      });
      const badgeRow = row.createDiv({ cls: 'a4r-hl-book-badge-row' });
      this.renderHighlightBookBadge(badgeRow, h);
      if (h.format === 'pdf') {
        row.createDiv({ cls: 'a4r-loc', text: `PDF page ${h.location_page ?? '—'}` });
      }
      row.createDiv({ cls: 'a4r-hl-queue-excerpt', text: `"${truncate(h.excerpt, 90)}"` });
      if (isLinked) {
        row.createDiv({
          cls: 'a4r-topic-link',
          text: `→ ${h.topic_path ? h.topic_path.split('/').pop().replace(/\.md$/, '') : (h.topic_slug || 'linked')}`,
        });
        row.onclick = () => { this.hlActiveHighlightPath = h.file.path; this.render(); };
        continue;
      }
      row.onclick = () => { this.hlActiveHighlightPath = h.file.path; this.render(); };
      const dismissBtn = row.createEl('button', { cls: 'a4r-hl-queue-dismiss', text: '✕', attr: { 'aria-label': 'Dismiss this highlight' } });
      dismissBtn.onclick = async (e) => {
        e.stopPropagation();
        await this.dismissTriageHighlight(h.file);
        if (this.hlActiveHighlightPath === h.file.path) this.hlActiveHighlightPath = null;
        this.render();
      };
    }

    if (!current) {
      if (!shown.length) left.remove();
      grid.createDiv({ cls: 'a4r-empty-state', text: 'Nothing left to review — every highlight in your library has been linked or dismissed.' });
      return;
    }

    grid.createDiv({ cls: 'a4r-hl-triage-arrow', text: '→' });

    const right = grid.createDiv({ cls: 'a4r-hl-triage-right' });
    this.renderHighlightBookBadge(right, current);
    if (current.format === 'pdf') {
      right.createDiv({ cls: 'a4r-loc', text: `PDF page ${current.location_page ?? '—'}` });
    }
    right.createDiv({ cls: 'a4r-quote', text: `"${current.excerpt}"` });
    this.renderHighlightLinkPanel(right, current);
  }

  // ==================== WORD LOOKUP (v0.13.0) ====================
  // Built to the approved mockup-word-lookup.html. Look up sits in the
  // selection pop-up next to the colours, only for a single word.

  // The sentence around the selected word, for "Save word" and the Pro
  // explanation: the block the selection starts in, split into sentences.
  lookupSentence(range, word) {
    let node = range && range.startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    const block = node && node.closest ? (node.closest('p,li,blockquote,h1,h2,h3,h4,div') || node) : null;
    const text = block ? String(block.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!text) return '';
    const hit = splitIntoSentences(text).map((s) => s.text.trim()).find((s) => s.toLowerCase().includes(word.toLowerCase()));
    return truncate(hit || text, 400);
  }

  // What the pop-up's extra button is, for this book and word: 'lookup',
  // 'download' (the book's language has a dictionary to download) or null.
  lookupButtonKind(r) {
    const lang = this.plugin.lookupLanguage(r);
    if (this.plugin.dictStatus(lang).installed) return 'lookup';
    if (DICT_LANGUAGES.some((l) => l.code === lang)) return 'download';
    return this.plugin.lookupAiReady() ? 'lookup' : null;
  }

  openLookupCard(rect, { word, sentence, r, onClose }) {
    const plugin = this.plugin;
    const lang = plugin.lookupLanguage(r);
    const found = plugin.dictLookup(lang, word);
    const card = this.openHighlightPopup(rect, { closeOnDeselect: false, onClose });
    card.addClass('a4r-lookup-card');
    card.setAttr('role', 'dialog');
    card.setAttr('aria-label', `Meaning of ${word}`);
    const head = card.createDiv({ cls: 'a4r-lookup-head' });
    head.createSpan({ cls: 'a4r-lookup-word', text: word });
    if (found && found.base && found.base !== word.toLowerCase()) card.createDiv({ cls: 'a4r-lookup-from', text: `from ${found.base}` });

    let meaning = '';
    if (found) {
      const ul = card.createEl('ul', { cls: 'a4r-lookup-senses' });
      for (const [pos, def, ex] of found.senses) {
        const li = ul.createEl('li');
        li.createSpan({ cls: 'a4r-lookup-pos', text: pos });
        li.appendText(def);
        if (ex) li.createSpan({ cls: 'a4r-lookup-ex', text: `"${ex}"` });
      }
      meaning = found.senses[0][1];
    } else {
      const name = (DICT_LANGUAGES.find((l) => l.code === lang) || {}).name;
      card.createDiv({
        cls: 'a4r-lookup-none',
        text: found === null ? 'This word isn\'t in the dictionary.' : (name ? `The ${name} dictionary isn't downloaded yet.` : 'There\'s no dictionary for this book\'s language yet.'),
      });
    }

    // "In this sentence" (Pro): the answer, a Pro note, or nothing.
    const aiBox = card.createDiv({ cls: 'a4r-lookup-ai' });
    let explanation = '';
    const drawAi = () => {
      aiBox.empty();
      if (!plugin.isPro()) {
        const k = aiBox.createDiv({ cls: 'a4r-lookup-k' });
        k.appendText('In this sentence');
        k.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });
        aiBox.createEl('p', { cls: 'a4r-lookup-dim', text: 'With Pro, get a short explanation of what this word means right here in the book.' });
      } else if (explanation) {
        const k = aiBox.createDiv({ cls: 'a4r-lookup-k' });
        k.appendText('In this sentence');
        k.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });
        aiBox.createEl('p', { text: explanation });
        if (aiBox.dataset.meta) aiBox.createDiv({ cls: 'a4r-lookup-meta', text: aiBox.dataset.meta });
      } else {
        aiBox.addClass('is-empty');
        return;
      }
      aiBox.removeClass('is-empty');
    };
    drawAi();

    const actions = card.createDiv({ cls: 'a4r-lookup-actions' });
    const save = actions.createEl('button', { cls: 'a4r-lookup-btn is-primary', text: 'Save word' });
    // Saving words is Pro (v0.16.0, built to the approved
    // mockup-pro-locks.html); looking up stays free.
    if (!plugin.isPro()) {
      save.createSpan({ cls: 'a4r-dash-pro a4r-pro-on-btn', text: 'Pro' });
      save.onclick = () => {
        if (card.querySelector('.a4r-lookup-pro-note')) return;
        const note = card.createDiv({ cls: 'a4r-lookup-pro-note' });
        note.createEl('b', { text: 'Saving words comes with Pro.' });
        note.appendText(' Your word list lives in Reading/Words, linked to each book.');
        if (apple) card.insertBefore(note, apple); // above the Apple link, under the buttons
        this.placeHighlightPopup(card, rect);
      };
    } else save.onclick = async () => {
      save.disabled = true;
      try {
        const res = await this.store.saveWord({ word: found && found.base ? found.base : word, meaning, bookFile: this.currentBook, quote: sentence, explanation });
        save.setText('Saved');
        new Notice(res.existed ? `Added this book to your note for "${res.file.basename}".` : `Saved "${res.file.basename}" to Reading/Words.`);
      } catch (err) {
        console.error('Reading Vault: could not save a word', err);
        save.disabled = false;
        new Notice("Couldn't save the word. Details are in the developer console.");
      }
    };
    if (plugin.lookupAiReady()) {
      const explain = actions.createEl('button', { cls: 'a4r-lookup-btn', text: 'Explain in this sentence' });
      explain.onclick = async () => {
        explain.disabled = true;
        explain.setText('Thinking…');
        const st = plugin.settings;
        const provider = st.askProvider;
        const model = plugin.askModel(provider);
        const fm = this.store.getFm(this.currentBook);
        const system = 'You explain what one word means in the sentence it appears in, for a reader with no specialist background. Answer in one to three short, plain sentences, in the same language as the sentence. Say what it means here, not every possible meaning.';
        const user = `Book: ${fm.title || this.currentBook.basename}${fm.author ? ` by ${fm.author}` : ''}\nSentence: "${sentence || word}"\nWord: "${word}"`;
        try {
          const res = await plugin.askComplete(provider, model, system, user);
          explanation = res.text;
          const info = plugin.askModelInfo(provider, model);
          aiBox.dataset.meta = [info.name, ASK_PROVIDERS[provider].short, fmtAskCost(res.inputTokens, res.outputTokens, info.price)].filter(Boolean).join(' · ');
          explain.remove();
          drawAi();
        } catch (err) {
          explain.disabled = false;
          explain.setText('Explain in this sentence');
          new Notice((err && err.message) || "Couldn't get an explanation.");
        }
      };
    }
    let apple = null;
    if (Platform.isMacOS) {
      apple = card.createEl('a', { cls: 'a4r-lookup-apple', text: 'Open in Apple Dictionary ↗', attr: { href: `dict://${encodeURIComponent(word)}` } });
      apple.onclick = (e) => { e.preventDefault(); window.open(`dict://${encodeURIComponent(word)}`); };
    }
    this.placeHighlightPopup(card, rect);
    return card;
  }


  // ==================== ASK THE BOOK (v0.10.0) ====================
  // The side panel's fourth tab, built to the approved
  // mockup-ask-the-book.html. Questions and answers live on this reading
  // session (r.ask) and are gone when the book closes, unless saved with
  // "Save to book note". The panel re-renders only itself, never the page.

  // What one question sends, as numbered sources S1, S2, ... Each kind is
  // switched on or off in Settings; the whole book is never sent.
  async gatherAskSources(r) {
    const st = this.plugin.settings;
    const sources = [];
    const add = (s) => { sources.push({ id: `S${sources.length + 1}`, ...s }); };
    const book = this.currentBook;

    if (st.askSendChapter) {
      if (r.format === 'epub' && r.epub.loaded && r.epub.spine[r.epub.idx]) {
        let html = null;
        try { html = readSpineChapter(r.epub.buf, r.epub.entries, r.epub.spine[r.epub.idx].resolvedPath); } catch { html = null; }
        if (html) {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('script,style').forEach((n) => n.remove());
          let used = 0;
          for (const el of doc.querySelectorAll('p,li,blockquote,h1,h2,h3,h4')) {
            if (el.querySelector('p,li,blockquote')) continue; // leaf blocks only, no double counting
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length < 3) continue;
            if (used + text.length > ASK_LIMITS.chapterChars) break;
            used += text.length;
            add({ kind: 'chapter', text, where: null });
          }
        }
      } else if (r.format === 'pdf' && r.pdf.doc) {
        const n = ASK_LIMITS.pdfPagesEachSide;
        const from = Math.max(1, r.pdf.page - n);
        const to = Math.min(r.pdf.pageCount || r.pdf.page, r.pdf.page + n);
        for (let p = from; p <= to; p += 1) {
          try {
            const pg = await r.pdf.doc.getPage(p);
            const tc = await pg.getTextContent();
            const text = tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
            if (text) add({ kind: 'chapter', text, where: `p. ${p}` });
          } catch { /* unreadable page -- skip it */ }
        }
      }
    }

    const highlights = book ? this.store.listHighlights(book.path).filter((h) => h.status !== 'dismissed').slice(-ASK_LIMITS.highlights) : [];
    if (st.askSendHighlights) {
      for (const h of highlights) {
        const where = describeHighlightLocationForNote(h);
        if (h.excerpt) add({ kind: 'highlight', text: h.excerpt, where, hlPath: h.file.path });
        if (h.note) add({ kind: 'note', text: String(h.note), where, hlPath: h.file.path });
      }
    }

    if (st.askSendTopics) {
      const seen = new Set();
      for (const h of highlights) {
        if (h.status !== 'linked' || !h.topic_path || seen.has(h.topic_path)) continue;
        seen.add(h.topic_path);
        if (seen.size > ASK_LIMITS.topicNotes) break;
        const f = this.app.vault.getAbstractFileByPath(h.topic_path);
        if (!(f instanceof TFile)) continue;
        let text = '';
        try { text = await this.app.vault.cachedRead(f); } catch { text = ''; }
        text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim().slice(0, ASK_LIMITS.topicChars);
        if (text) add({ kind: 'topic', text, title: f.basename, topicPath: f.path });
      }
    }
    return sources;
  }

  askSentSummary(sources, st) {
    const count = (k) => sources.filter((s) => s.kind === k).length;
    const lines = ['Your question'];
    const hl = count('highlight');
    const notes = count('note');
    if (st.askSendHighlights) lines.push(`${hl} ${hl === 1 ? 'highlight' : 'highlights'} from this book${notes ? `, with ${notes} ${notes === 1 ? 'note' : 'notes'}` : ''}`);
    if (st.askSendTopics) {
      const topics = sources.filter((s) => s.kind === 'topic').map((s) => s.title);
      lines.push(topics.length ? `${topics.length} Topic ${topics.length === 1 ? 'note' : 'notes'}: ${topics.join(', ')}` : 'No linked Topic notes');
    }
    if (st.askSendChapter) {
      const words = sources.filter((s) => s.kind === 'chapter').reduce((n, s) => n + s.text.split(/\s+/).length, 0);
      lines.push(words ? `${this.reader && this.reader.format === 'pdf' ? 'The pages around this one' : "This chapter's text"} (about ${words.toLocaleString('en-US')} words)` : 'No chapter text could be read');
    }
    return lines;
  }

  async runAsk(bodyEl, r, appEl, question) {
    const q = String(question || '').trim();
    if (!q || !this.currentBook) return;
    const plugin = this.plugin;
    const st = plugin.settings;
    r.ask = r.ask || { items: [], draft: '' };
    const provider = st.askProvider;
    const model = plugin.askModel(provider);
    const item = { question: q, status: 'loading', provider, model };
    r.ask.items.push(item);
    r.ask.draft = '';
    this.renderAskPanel(bodyEl, r, appEl);
    try {
      const sources = await this.gatherAskSources(r);
      item.sent = this.askSentSummary(sources, st);
      const fm = this.store.getFm(this.currentBook);
      const user = buildAskMessage({ title: fm.title || this.currentBook.basename, author: fm.author, question: q, sources });
      const res = await plugin.askComplete(provider, model, ASK_SYSTEM_PROMPT, user);
      if (!res.text) throw new Error('The answer came back empty. Try asking again.');
      item.parsed = parseAskAnswer(res.text, sources);
      const info = plugin.askModelInfo(provider, model);
      item.modelName = info.name;
      item.cost = fmtAskCost(res.inputTokens, res.outputTokens, info.price);
      item.status = 'done';
    } catch (err) {
      if (err && err.status === undefined) console.error('Reading Vault: Ask failed', err);
      item.status = 'error';
      item.error = (err && err.message) || 'Something went wrong. Try again.';
    }
    if (this.reader === r && r.sidePanelTab === 'ask' && bodyEl.isConnected) this.renderAskPanel(bodyEl, r, appEl);
  }

  renderAskPanel(bodyEl, r, appEl) {
    const plugin = this.plugin;
    bodyEl.empty();
    const wrap = bodyEl.createDiv({ cls: 'a4r-ask' });
    const head = wrap.createDiv({ cls: 'a4r-ask-k' });
    head.appendText('Ask this book');
    head.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });

    const readiness = plugin.askReadiness();
    if (readiness !== 'ready') {
      const empty = wrap.createDiv({ cls: 'a4r-ask-empty' });
      if (readiness === 'locked') {
        empty.createEl('h4', { text: 'Ask is part of Pro' });
        empty.createEl('p', { text: 'Ask questions about the book you are reading and get answers from your own highlights, notes and Topic notes. It becomes available when you upgrade to Pro.' });
        return;
      }
      if (readiness === 'no-secure-storage') {
        empty.createEl('h4', { text: 'Update Obsidian to use Ask' });
        empty.createEl('p', { text: 'Ask keeps your key in Obsidian\'s secure storage, which needs Obsidian 1.11.4 or later.' });
        return;
      }
      empty.createEl('h4', { text: readiness === 'no-model' ? 'Pick a model to start asking' : 'Add a key to start asking' });
      empty.createEl('p', { text: readiness === 'no-model'
        ? 'Choose which model answers in Settings, then come back here.'
        : 'Ask uses an AI service you pay for directly: Anthropic, OpenAI or OpenRouter. Turn Ask on and add a key in Settings, then come back here.' });
      const open = empty.createEl('button', { cls: 'a4r-ask-btn is-primary', text: 'Open Settings' });
      open.onclick = () => plugin.openOwnSettings();
      return;
    }

    r.ask = r.ask || { items: [], draft: '' };
    for (const item of r.ask.items) this.renderAskItem(wrap, item, r, appEl);

    const box = wrap.createDiv({ cls: 'a4r-ask-box' });
    const ta = box.createEl('textarea', { attr: { placeholder: 'Ask about this book…', 'aria-label': 'Your question', rows: '3' } });
    ta.value = r.ask.draft || '';
    const row = box.createDiv({ cls: 'a4r-ask-row' });
    const st = plugin.settings;
    const scope = [st.askSendHighlights && 'highlights', st.askSendTopics && 'Topic notes', st.askSendChapter && (r.format === 'pdf' ? 'these pages' : 'this chapter')].filter(Boolean);
    row.createSpan({ cls: 'a4r-ask-scope', text: scope.length ? `Uses your ${scope.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : 'Sends only your question' });
    const busy = r.ask.items.some((i) => i.status === 'loading');
    const go = row.createEl('button', { cls: 'a4r-ask-btn is-primary', text: busy ? 'Asking…' : 'Ask' });
    go.disabled = busy || !ta.value.trim();
    ta.oninput = () => { r.ask.draft = ta.value; go.disabled = busy || !ta.value.trim(); };
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !go.disabled) { e.preventDefault(); go.click(); }
    };
    go.onclick = () => this.runAsk(bodyEl, r, appEl, ta.value);

    if (!r.ask.items.length) {
      wrap.createDiv({ cls: 'a4r-ask-k', text: 'Try asking' });
      const chips = wrap.createDiv({ cls: 'a4r-ask-chips' });
      const hls = this.currentBook ? this.store.listHighlights(this.currentBook.path).filter((h) => h.status !== 'dismissed') : [];
      const topic = hls.find((h) => h.status === 'linked' && h.topic_path);
      const ideas = [r.format === 'pdf' ? 'What is the author arguing on these pages?' : 'What is the author actually arguing in this chapter?'];
      if (topic) ideas.push(`How does this connect to my ${topic.topic_path.split('/').pop().replace(/\.md$/, '')} notes?`);
      if (hls.length) ideas.push("Summarise what I've highlighted so far");
      for (const idea of ideas) {
        const c = chips.createEl('button', { cls: 'a4r-ask-chip', text: idea });
        c.onclick = () => { ta.value = idea; r.ask.draft = idea; go.disabled = busy; ta.focus(); };
      }
    }
  }

  renderAskItem(wrap, item, r, appEl) {
    const qa = wrap.createDiv({ cls: 'a4r-ask-qa' });
    qa.createDiv({ cls: 'a4r-ask-q', text: item.question });
    if (item.status === 'loading') { qa.createDiv({ cls: 'a4r-ask-wait', text: 'Thinking…' }); return; }
    if (item.status === 'error') { qa.createDiv({ cls: 'a4r-ask-error', text: item.error }); return; }

    const answer = qa.createDiv({ cls: 'a4r-ask-a' });
    const cards = [];
    const flash = (n) => {
      cards.forEach((c, i) => c.toggleClass('is-flash', i === n - 1));
      const c = cards[n - 1];
      if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' });
    };
    for (const runs of item.parsed.paragraphs) {
      const p = answer.createEl('p');
      for (const run of runs) {
        if (run.cite) {
          const b = p.createEl('button', { cls: 'a4r-ask-cite', text: String(run.cite), attr: { 'aria-label': `Source ${run.cite}` } });
          b.onclick = () => flash(run.cite);
        } else {
          p.appendText(run.text);
        }
      }
    }
    if (item.parsed.used.length) {
      const list = qa.createDiv({ cls: 'a4r-ask-sources' });
      item.parsed.used.forEach((s, i) => {
        const card = list.createDiv({ cls: 'a4r-ask-src' });
        card.createSpan({ cls: 'a4r-ask-cite a4r-ask-src-n', text: String(i + 1) });
        const body = card.createDiv();
        body.createDiv({ cls: s.kind === 'chapter' || s.kind === 'highlight' ? 'a4r-ask-src-quote' : 'a4r-ask-src-text', text: `"${truncate(s.text.replace(/\s+/g, ' '), 180)}"` });
        body.createDiv({ cls: 'a4r-ask-src-from', text: askSourceLabel(s) });
        if (s.hlPath) {
          card.addClass('is-link');
          setTooltip(card, 'Go to this highlight');
          card.onclick = () => {
            const f = this.app.vault.getAbstractFileByPath(s.hlPath);
            if (f instanceof TFile) this.jumpToHighlight({ file: f, ...this.store.getFm(f) }, r, appEl);
          };
        } else if (s.topicPath) {
          card.addClass('is-link');
          setTooltip(card, 'Open this Topic note');
          card.onclick = () => this.app.workspace.openLinkText(s.topicPath, '', 'tab');
        }
        cards.push(card);
      });
    }

    const foot = qa.createDiv({ cls: 'a4r-ask-foot' });
    const provider = ASK_PROVIDERS[item.provider] ? ASK_PROVIDERS[item.provider].short : item.provider;
    foot.createSpan({ text: [`Answered by ${item.modelName || item.model}`, provider, item.cost].filter(Boolean).join(' · ') });
    const btns = foot.createSpan({ cls: 'a4r-ask-foot-btns' });
    const copy = btns.createEl('button', { cls: 'a4r-ask-btn is-quiet', text: 'Copy' });
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(askAnswerToMarkdown(item.parsed));
        new Notice('Answer copied.');
      } catch { new Notice("Couldn't copy the answer."); }
    };
    const save = btns.createEl('button', { cls: 'a4r-ask-btn', text: item.saved ? 'Saved to book note' : 'Save to book note' });
    save.disabled = !!item.saved;
    save.onclick = async () => {
      if (item.saved || !this.currentBook) return;
      save.disabled = true;
      try {
        await this.store.saveAnswerToBookNote(this.currentBook, {
          question: item.question, markdown: askAnswerToMarkdown(item.parsed),
          model: `${item.modelName || item.model} (${provider})`, date: localDayKey(new Date()),
        });
        item.saved = true;
        save.setText('Saved to book note');
        new Notice('Saved to the book note, under "Questions".');
      } catch (err) {
        console.error('Reading Vault: could not save an answer', err);
        save.disabled = false;
        new Notice("Couldn't save to the book note. Details are in the developer console.");
      }
    };
    if (item.sent) {
      const det = qa.createEl('details', { cls: 'a4r-ask-sent' });
      det.createEl('summary', { text: 'What was sent' });
      const ul = det.createEl('ul');
      for (const line of item.sent) ul.createEl('li', { text: line });
    }
  }

  // ==================== HIGHLIGHT REVIEW (v0.9.0) ====================
  // Built to the approved mockup-highlight-review.html. Today's set is
  // planned once per local day (planReviewQueue) and kept on this.review,
  // so leaving for the book ("Open in book") and coming back resumes on the
  // same card. See the field notes above REVIEW_PER_DAY_CHOICES.
  startReview() {
    this.review = null;
    this.goto('review');
  }

  // "Add a thought" is saved to the highlight's own note by its Save button
  // (v0.9.1, John asked for one), and also when you move on (answer, "Open
  // in book", or leaving the screen) so typed text is never lost. Never on
  // each keypress. The saved note is remembered on the session
  // (s.savedNote) so the card shows it straight away, even before
  // Obsidian's metadata cache has caught up with the write.
  async flushReviewThought() {
    const s = this.review;
    if (!s || !s.thought || !s.thought.trim() || !s.currentPath) return false;
    const text = s.thought;
    const path = s.currentPath;
    s.thought = '';
    s.thoughtOpen = false;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const note = await this.store.addHighlightThought(file, text);
    if (note) s.savedNote = { path, note };
    return !!note;
  }

  renderReview(body) {
    const plugin = this.plugin;
    const now = new Date();
    const todayKey = localDayKey(now);
    const root = body.createDiv({ cls: 'a4r-rv' });
    const head = root.createDiv({ cls: 'a4r-rv-head' });
    const title = head.createDiv({ cls: 'a4r-rv-title' });
    title.createEl('h2', { text: 'Review' });
    title.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });

    if (!this.plugin.isPro()) {
      root.createDiv({ cls: 'a4r-rv-empty', text: 'Highlight review is part of Reading Vault Pro. Your highlights, notes and Topic links stay free.' });
      return;
    }

    let s = this.review;
    if (!s || s.date !== todayKey) {
      const queue = planReviewQueue(this.store.listHighlights(), todayKey, plugin.settings.reviewPerDay || 5, plugin.reviewDoneToday(now));
      s = this.review = { date: todayKey, paths: queue.map((h) => h.file.path), i: 0, revealed: false, thoughtOpen: false, thought: '', results: [], currentPath: null };
    }
    // Drop anything deleted, unlinked or stopped since the set was planned.
    let h = null;
    while (s.i < s.paths.length) {
      const f = this.app.vault.getAbstractFileByPath(s.paths[s.i]);
      const fm = f instanceof TFile ? this.store.getFm(f) : null;
      if (fm && isInReview(fm)) { h = { file: f, ...fm }; break; }
      s.paths.splice(s.i, 1);
    }
    s.currentPath = h ? h.file.path : null;

    const total = s.paths.length;
    if (total) {
      const prog = head.createDiv({ cls: 'a4r-rv-progress' });
      const pips = prog.createDiv({ cls: 'a4r-rv-pips', attr: { 'aria-hidden': 'true' } });
      for (let k = 0; k < total; k += 1) pips.createEl('i', { cls: k < s.i ? 'is-done' : (k === s.i ? 'is-now' : '') });
      prog.createSpan({ text: h ? `${s.i + 1} of ${total}` : 'All done' });
    }

    if (!h) { this.renderReviewDone(root, now); return; }
    this.renderReviewCard(root, h, s, now);
  }

  renderReviewCard(root, h, s, now) {
    const plugin = this.plugin;
    const grid = root.createDiv({ cls: 'a4r-rv-grid' });
    const card = grid.createDiv({ cls: 'a4r-rv-card' });

    const bookFile = h.book_path ? this.app.vault.getAbstractFileByPath(h.book_path) : null;
    const bookFm = bookFile instanceof TFile ? this.store.getFm(bookFile) : {};
    const bookTitle = bookFm.title || h.book_title || (bookFile ? bookFile.basename : 'Unknown book');
    const src = card.createDiv({ cls: 'a4r-rv-src' });
    const cover = src.createDiv({ cls: 'a4r-rv-cover' });
    if (bookFm.cover_path) {
      const img = cover.createEl('img', { attr: { alt: '' } });
      img.src = this.app.vault.adapter.getResourcePath(bookFm.cover_path);
    } else {
      const [bg, fg] = pickPlaceholderColor(bookTitle);
      cover.style.background = bg; cover.style.color = fg;
      cover.setText(bookTitle.trim().charAt(0).toUpperCase());
    }
    const srcText = src.createDiv();
    srcText.createDiv({ cls: 'a4r-rv-src-title', text: bookTitle });
    const where = describeHighlightLocationForNote(h);
    const meta = [bookFm.author, where].filter(Boolean).join(' · ');
    if (meta) srcText.createDiv({ cls: 'a4r-rv-src-meta', text: meta });

    const topicName = h.topic_path ? h.topic_path.split('/').pop().replace(/\.md$/, '') : (h.topic_slug || 'Topic');
    const showPassage = !plugin.settings.reviewRememberFirst || s.revealed;

    const answer = async (days) => {
      if (s.busy) return;
      s.busy = true;
      try {
        await this.flushReviewThought();
        await this.store.recordReview(h.file, days, now);
        await plugin.noteReviewDone(now);
        s.results.push({ excerpt: h.excerpt || '', days });
        s.i += 1;
        s.revealed = false;
        s.thoughtOpen = false;
      } catch (err) {
        console.error('Reading Vault: could not save a review', err);
        new Notice('That review could not be saved. Details are in the developer console.');
      }
      s.busy = false;
      this.render();
      plugin.refreshDashboards();
    };

    if (showPassage) {
      const p = card.createEl('p', { cls: 'a4r-rv-passage' });
      const mark = p.createEl('mark', { text: h.excerpt || '' });
      mark.style.setProperty('--a4r-rv-hl', h.color || HIGHLIGHT_COLORS[0].hex);

      const noteBox = card.createDiv({ cls: 'a4r-rv-note' });
      noteBox.createDiv({ cls: 'a4r-rv-k', text: 'Your note' });
      const note = s.savedNote && s.savedNote.path === h.file.path ? s.savedNote.note : h.note;
      if (note) noteBox.createEl('p', { text: String(note) });
      else noteBox.createEl('p', { cls: 'a4r-rv-dim', text: 'No note on this one yet.' });
      if (s.thoughtOpen) {
        const ta = noteBox.createEl('textarea', { cls: 'a4r-rv-thought', attr: { placeholder: 'What does it make you think of today?', 'aria-label': 'Add a thought' } });
        ta.value = s.thought || '';
        const bar = noteBox.createDiv({ cls: 'a4r-rv-thought-actions' });
        const save = bar.createEl('button', { cls: 'a4r-rv-btn is-primary', text: 'Save' });
        const cancel = bar.createEl('button', { cls: 'a4r-rv-quiet', text: 'Cancel' });
        save.disabled = !(s.thought || '').trim();
        ta.oninput = () => { s.thought = ta.value; save.disabled = !ta.value.trim(); };
        save.onclick = async () => {
          if (s.busy || !(s.thought || '').trim()) return;
          s.busy = true;
          try {
            if (await this.flushReviewThought()) new Notice("Saved to this highlight's note.");
          } catch (err) {
            console.error('Reading Vault: could not save a thought', err);
            new Notice('That thought could not be saved. Details are in the developer console.');
          }
          s.busy = false;
          this.render();
        };
        cancel.onclick = () => { s.thought = ''; s.thoughtOpen = false; this.render(); };
        window.setTimeout(() => ta.focus(), 0);
      } else {
        const add = noteBox.createEl('button', { cls: 'a4r-rv-quiet', text: '+ Add a thought' });
        add.onclick = () => { s.thoughtOpen = true; this.render(); };
      }

      const rate = card.createDiv({ cls: 'a4r-rv-rate' });
      rate.createEl('p', { cls: 'a4r-rv-rate-q', text: 'When should this come back?' });
      const row = rate.createDiv({ cls: 'a4r-rv-rate-row' });
      for (const c of reviewChoices(h.review_interval)) {
        const b = row.createEl('button', { cls: `a4r-rv-rate-btn${c.key === 'good' ? ' is-mid' : ''}` });
        b.dataset.days = String(c.days);
        b.createEl('b', { text: c.label });
        b.createSpan({ text: fmtReviewGap(c.days) });
        b.onclick = () => answer(c.days);
      }
      const retire = rate.createDiv({ cls: 'a4r-rv-retire' });
      const stop = retire.createEl('button', { cls: 'a4r-rv-quiet', text: 'Stop showing this one' });
      stop.onclick = () => answer(0);
    } else {
      const cue = card.createDiv({ cls: 'a4r-rv-cue' });
      const line = cue.createEl('p');
      line.appendText('Linked to ');
      line.createEl('b', { text: topicName });
      cue.createEl('p', { cls: 'a4r-rv-dim', text: 'Try to remember the passage before you look.' });
      const show = cue.createEl('button', { cls: 'a4r-rv-btn is-primary', text: 'Show passage' });
      show.onclick = () => { s.revealed = true; this.render(); };
    }

    const actions = card.createDiv({ cls: 'a4r-rv-actions' });
    const open = actions.createEl('button', { cls: 'a4r-rv-btn', text: 'Open in book' });
    open.onclick = async () => {
      await this.flushReviewThought();
      this.openHighlightInReader(h.file.path);
    };

    // Right column: the Topic it's linked to, and what else lives there.
    const side = grid.createDiv({ cls: 'a4r-rv-side' });
    const tc = side.createDiv({ cls: 'a4r-rv-card' });
    tc.createDiv({ cls: 'a4r-rv-k', text: 'Linked to' });
    const chip = tc.createEl('a', { cls: 'a4r-rv-topic', text: `[[${topicName}]] ↗`, attr: { href: '#' } });
    chip.onclick = (e) => {
      e.preventDefault();
      if (h.topic_path) this.app.workspace.openLinkText(h.topic_path, '', 'tab');
    };
    const also = this.store.listHighlights()
      .filter((o) => o.status === 'linked' && o.file.path !== h.file.path && o.topic_path && o.topic_path === h.topic_path)
      .slice(0, 3);
    if (also.length) {
      tc.createEl('p', { cls: 'a4r-rv-sub', text: 'Also in this Topic note:' });
      const ul = tc.createEl('ul', { cls: 'a4r-rv-also' });
      for (const o of also) {
        const li = ul.createEl('li');
        li.createEl('q', { text: truncate(o.excerpt || '', 160) });
        const ob = o.book_path ? this.app.vault.getAbstractFileByPath(o.book_path) : null;
        const ofm = ob instanceof TFile ? this.store.getFm(ob) : {};
        li.createSpan({ cls: 'a4r-rv-from', text: [ofm.title || o.book_title, ofm.author].filter(Boolean).join(' · ') });
      }
    } else {
      tc.createEl('p', { cls: 'a4r-rv-sub', text: 'This is the only highlight in that Topic so far.' });
    }

    const fc = side.createDiv({ cls: 'a4r-rv-card' });
    fc.createDiv({ cls: 'a4r-rv-k', text: 'This highlight' });
    const dl = fc.createEl('dl', { cls: 'a4r-rv-facts' });
    const count = Number(h.review_count) || 0;
    dl.createEl('dt', { text: 'Reviewed' });
    dl.createEl('dd', { text: count ? `${count} ${count === 1 ? 'time' : 'times'}` : 'Not yet' });
    const last = reviewLastSeen(h);
    dl.createEl('dt', { text: 'Last seen' });
    dl.createEl('dd', { text: last ? fmtDaysAgo(last, now) : 'Never, this is its first time' });
  }

  renderReviewDone(root, now) {
    const plugin = this.plugin;
    const s = this.review;
    const sum = plugin.reviewSummary(now);
    const done = root.createDiv({ cls: 'a4r-rv-done' });
    const goLibrary = () => this.goto('grid');

    if (s.results.length) {
      done.createDiv({ cls: 'a4r-rv-check', text: '✓', attr: { 'aria-hidden': 'true' } });
      done.createEl('h3', { text: 'Done for today' });
      const n = s.results.length;
      done.createEl('p', { text: `You looked at ${n} ${n === 1 ? 'highlight' : 'highlights'}. Here is when each one comes back.` });
      const ul = done.createEl('ul', { cls: 'a4r-rv-recap' });
      for (const r of s.results) {
        const li = ul.createEl('li');
        li.createSpan({ cls: 'a4r-rv-recap-ex', text: `"${truncate(r.excerpt, 90)}"` });
        li.createSpan({ cls: 'a4r-rv-recap-when', text: r.days ? `back ${fmtReviewGap(r.days)}` : "won't come back" });
      }
    } else if (!sum.linked) {
      done.createEl('h3', { text: 'Nothing to review yet' });
      done.createEl('p', { text: 'Review brings back highlights you have linked to a Topic note. Link a highlight in the Highlights tab and it will start showing up here.' });
      const go = done.createDiv({ cls: 'a4r-rv-actions' }).createEl('button', { cls: 'a4r-rv-btn is-primary', text: 'Go to Highlights' });
      go.onclick = () => { this.currentBook = null; this.goto('highlights'); };
      return;
    } else if (sum.doneToday) {
      done.createDiv({ cls: 'a4r-rv-check', text: '✓', attr: { 'aria-hidden': 'true' } });
      done.createEl('h3', { text: 'Done for today' });
      done.createEl('p', { text: 'You have already reviewed today. More come back tomorrow.' });
    } else {
      done.createEl('h3', { text: 'Nothing to review today' });
      done.createEl('p', { text: 'Every linked highlight is scheduled for later.' });
    }
    if (sum.tomorrow) {
      done.createEl('p', { cls: 'a4r-rv-next', text: `Tomorrow: ${sum.tomorrow} ${sum.tomorrow === 1 ? 'highlight' : 'highlights'} ready.` });
    } else if (sum.nextDay) {
      done.createEl('p', { cls: 'a4r-rv-next', text: `Next review: ${fmtMonthDay(sum.nextDay)}.` });
    }
    const back = done.createDiv({ cls: 'a4r-rv-actions' }).createEl('button', { cls: 'a4r-rv-btn is-primary', text: 'Back to Library' });
    back.onclick = goLibrary;
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------
// Settings page (Settings → Community plugins → Reading Vault), built from the
// mockup John approved 2026-09-22 (03 WiP/2026-09-22-business-ideas/
// mockup-a4-reading-settings.html). Uses display() like the other A4
// plugins' settings pages.
// ---------------------------------------------------------------------------
class ReadingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.onVoicesChanged = () => { if (this.containerEl.isConnected) this.redraw(); };
  }

  display() {
    const plugin = this.plugin;
    const el = this.containerEl;
    this.shown = true;
    el.empty();
    plugin.kokoroWarmUp();
    plugin.onPreviewChange = () => {
      el.querySelectorAll('.a4r-settings-play').forEach((b) => this.setPlayButton(b, b.dataset.voiceId === plugin.previewId));
    };
    el.addClass('a4r-settings');
    // The Mac's voice list can arrive a moment after the page opens.
    if (window.speechSynthesis && !this.listeningForVoices) {
      window.speechSynthesis.addEventListener('voiceschanged', this.onVoicesChanged);
      this.listeningForVoices = true;
    }

    this.proSettings(el);
    this.foldersSection(el);

    new Setting(el).setName('Read aloud').setHeading();

    const lang = plugin.readingLanguage();
    new Setting(el)
      .setName('Reading language')
      .setDesc(plugin.naturalVoicesUnlocked()
        ? 'The language your books are read aloud in. English uses the natural (Kokoro) voices; other languages use the voices on this Mac.'
        : 'The language your books are read aloud in, with the voices on this Mac. The natural English voices come with Pro.')
      .addDropdown((d) => {
        d.addOption('en', 'English');
        for (const l of plugin.systemLanguages()) d.addOption(l.code, l.label);
        d.setValue(lang);
        d.onChange(async (value) => {
          plugin.settings.ttsLanguage = value;
          plugin.voiceChoice(value);
          await plugin.saveSettings();
          this.refreshReaders();
          this.redraw();
        });
      });

    const choice = plugin.voiceChoice(lang);
    const voicesSetting = new Setting(el)
      .setName('Voices in the Voice list')
      .setDesc('Tick the voices you want to choose from while reading. Press ▶ to hear a short sample.');
    // The tick-box grid lives inside this setting's own row, so it sits in
    // the same settings card as the rows around it.
    voicesSetting.settingEl.addClass('a4r-settings-voices-item');
    const box = voicesSetting.settingEl.createDiv({ cls: 'a4r-settings-voices' });
    const natural = lang === 'en' && plugin.naturalVoicesUnlocked();
    const ids = natural
      ? KOKORO_ALL_VOICES.map((k) => `kokoro:${k[0]}`)
      : plugin.systemVoices().filter((v) => plugin.langOf(v) === lang).map((v) => v.voiceURI);
    const infos = ids.map((id) => plugin.voiceInfo(id)).filter(Boolean);
    const groups = natural
      ? [['Women', infos.filter((v) => v.gender === 'w')], ['Men', infos.filter((v) => v.gender === 'm')]]
      : [['Voices', infos]];
    const hint = document.createElement('div');
    hint.className = 'a4r-settings-hint';
    for (const [title, list] of groups) {
      if (!list.length) continue;
      box.createDiv({ cls: 'a4r-settings-group', text: title });
      const grid = box.createDiv({ cls: 'a4r-settings-grid' });
      for (const v of list) this.voiceRow(grid, v, choice);
    }
    box.appendChild(hint);
    const one = choice.ticked.length === 1;
    hint.toggleClass('a4r-warn', one);
    hint.setText(one
      ? 'This is your last ticked voice, so it stays on. Tick another voice first to switch it off.'
      : 'At least one voice always stays ticked. The last ticked voice can\'t be unticked.');

    new Setting(el)
      .setName('Default voice')
      .setDesc('The voice that reads when you press play. Only ticked voices can be picked here.')
      .addDropdown((d) => {
        for (const id of choice.ticked) {
          const v = plugin.voiceInfo(id);
          if (v) d.addOption(id, v.kokoro ? `${v.name} · ${v.accent}` : `${v.name} · ${v.accent}`);
        }
        if (choice.default) d.setValue(choice.default);
        d.onChange(async (value) => { choice.default = value; await plugin.saveSettings(); this.refreshReaders(); });
      });

    if (natural) this.kokoroRow(el);
    else if (lang === 'en') this.naturalVoicesProCard(el);

    new Setting(el).setName('Reading').setHeading();
    new Setting(el)
      .setName('Page colour')
      .setDesc('How book pages look when you open the Reader. Auto follows your computer\'s light or dark setting. You can still change it for a book with the buttons above the page.')
      .addDropdown((d) => {
        d.addOption('auto', 'Auto');
        d.addOption('dark', 'Dark');
        d.addOption('light', 'Light');
        d.setValue(['auto', 'dark', 'light'].includes(plugin.settings.pageColour) ? plugin.settings.pageColour : 'auto');
        d.onChange(async (value) => { plugin.settings.pageColour = value; await plugin.saveSettings(); });
      });

    new Setting(el)
      .setName('Highlights in the book note')
      .setDesc("Keep an auto-updated \"Highlights\" section at the bottom of every book's own note, below your Notes. Turning this off stops future updates — it does not remove a section that's already there.")
      .addToggle((t) => {
        t.setValue(!!plugin.settings.highlightsInBookNote);
        t.onChange(async (value) => {
          plugin.settings.highlightsInBookNote = value;
          // Turned off, highlights added meanwhile aren't copied in; so
          // turning it back on brings every book up to date again (QA fix
          // v0.17.3). Only notes whose section would change are written.
          if (!value) plugin.settings.highlightsBackfillDone = false;
          await plugin.saveSettings();
          if (value) plugin.runHighlightsBackfillIfNeeded().catch((err) => console.error('Reading Vault: highlights backfill failed', err));
        });
      });

    // Highlight review (v0.9.0), from the approved mockup's settings rows.
    new Setting(el).setName('Highlight review').setHeading();
    new Setting(el)
      .setName('Highlights per day')
      .setDesc("How many come back each day. Anything you don't get to waits for tomorrow, it doesn't pile up.")
      .addDropdown((d) => {
        for (const n of REVIEW_PER_DAY_CHOICES) d.addOption(String(n), String(n));
        const cur = REVIEW_PER_DAY_CHOICES.includes(plugin.settings.reviewPerDay) ? plugin.settings.reviewPerDay : 5;
        d.setValue(String(cur));
        d.onChange(async (value) => { plugin.settings.reviewPerDay = Number(value); await plugin.saveSettings(); });
      });
    new Setting(el)
      .setName('Remember first')
      .setDesc('Hide the passage until you tap "Show passage", so you try to remember it before you see it.')
      .addToggle((t) => {
        t.setValue(!!plugin.settings.reviewRememberFirst);
        t.onChange(async (value) => { plugin.settings.reviewRememberFirst = value; await plugin.saveSettings(); });
      });

    // Ask the book (v0.10.0), from the approved mockup's settings section.
    this.askSettings(el);
    this.lookupSettings(el);
  }

  // Word lookup (v0.13.0), from the approved mockup's settings section.
  lookupSettings(el) {
    const plugin = this.plugin;
    const st = plugin.settings;
    new Setting(el).setName('Word lookup').setHeading();
    this.dictJob = this.dictJob || null; // { lang, pct, error } while a download runs

    const installed = DICT_LANGUAGES.filter((l) => plugin.dictStatus(l.code).installed);
    const available = DICT_LANGUAGES.filter((l) => !installed.includes(l));
    const dl = new Setting(el)
      .setName('Dictionaries')
      .setDesc("Download a dictionary once and it works offline from then on. Look up uses the one that matches the book's language.");
    dl.settingEl.addClass('a4r-settings-dicts');
    if (available.length) {
      let pick = available[0].code;
      dl.addDropdown((d) => {
        for (const l of available) d.addOption(l.code, `${l.name} · ${l.approx}`);
        d.setValue(pick);
        d.onChange((v) => { pick = v; });
        d.setDisabled(!!this.dictJob);
        d.selectEl.disabled = !!this.dictJob;
      });
      dl.addButton((b) => {
        b.setButtonText(this.dictJob ? 'Downloading…' : 'Download');
        b.setCta();
        b.setDisabled(!!this.dictJob);
        b.onClick(async () => {
          if (this.dictJob) return;
          const lang = pick;
          this.dictJob = { lang, pct: 0, error: null };
          this.redraw();
          try {
            await plugin.dictInstall(lang, (pct) => {
              this.dictJob.pct = pct;
              const bar = el.querySelector('.a4r-settings-dict-bar i');
              if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
            });
            const name = DICT_LANGUAGES.find((l) => l.code === lang).name;
            new Notice(`The ${name} dictionary is ready.`);
            this.dictJob = null;
          } catch (err) {
            this.dictJob = { lang, pct: 0, error: (err && err.message) || "The dictionary didn't download." };
          }
          this.redraw();
          if (this.dictJob && this.dictJob.error) this.dictJob = null; // message shown once, then the button works again
        });
      });
    }
    const box = dl.settingEl.createDiv({ cls: 'a4r-settings-dict-list' });
    if (this.dictJob) {
      const row = box.createDiv({ cls: 'a4r-settings-dict-row' });
      const name = DICT_LANGUAGES.find((l) => l.code === this.dictJob.lang).name;
      if (this.dictJob.error) {
        row.addClass('is-error');
        row.createSpan({ text: this.dictJob.error });
      } else {
        row.createSpan({ text: `${name} · Downloading…` });
        const bar = row.createSpan({ cls: 'a4r-settings-dict-bar' });
        bar.createEl('i').style.width = `${Math.round((this.dictJob.pct || 0) * 100)}%`;
      }
    }
    for (const l of installed) {
      const s = plugin.dictStatus(l.code);
      const row = box.createDiv({ cls: 'a4r-settings-dict-row' });
      row.createSpan({ text: `${l.name} · Downloaded · ${Math.max(1, Math.round(s.bytes / 1e6))} MB${s.source ? ` · ${s.source}` : ''}` });
      const rm = row.createEl('button', { text: 'Remove' });
      rm.onclick = () => { plugin.dictRemove(l.code); new Notice(`Removed the ${l.name} dictionary.`); this.redraw(); };
    }
    if (!installed.length && !this.dictJob) box.createDiv({ cls: 'a4r-settings-dict-row is-empty', text: 'No dictionaries yet. Pick a language and press Download.' });

    const ai = new Setting(el)
      .setName('Explain in this sentence')
      .setDesc(plugin.isPro()
        ? `Adds a button to the lookup card that explains what the word means right there in the book. Uses the same service and key as Ask the book${plugin.askReadiness() === 'ready' ? '.' : ', so turn on Ask and add a key above for it to work.'}`
        : 'Part of Pro. Explains what a word means right there in the book.')
      .addToggle((t) => {
        t.setValue(!!st.lookupAiEnabled && plugin.isPro());
        t.setDisabled(!plugin.isPro());
        if (t.toggleEl) t.toggleEl.disabled = !plugin.isPro();
        t.onChange(async (v) => { st.lookupAiEnabled = v; await plugin.saveSettings(); });
      });
    ai.nameEl.createSpan({ cls: 'a4r-settings-pro', text: 'Pro' });

    new Setting(el).setDesc('English comes from Princeton WordNet. Other languages come from Wiktionary, the free dictionary anyone can edit, shared under its open licence. Dictionaries are kept on this computer, outside your vault.');
  }

  askSettings(el) {
    const plugin = this.plugin;
    const st = plugin.settings;
    const pro = plugin.isPro();
    const secure = plugin.askSecretsAvailable();
    const heading = new Setting(el).setName('Ask the book').setHeading();
    heading.nameEl.createSpan({ cls: 'a4r-settings-pro', text: 'Pro' });

    if (!pro) {
      new Setting(el).setName('Ask is part of Pro')
        .setDesc('Ask questions about the book you are reading, answered from your own highlights and notes. Adding a key for Anthropic, OpenAI or OpenRouter becomes available when you upgrade to Pro.');
    } else if (!secure) {
      new Setting(el).setName('Update Obsidian to use Ask')
        .setDesc("Ask keeps your key in Obsidian's secure storage, which needs Obsidian 1.11.4 or later. Nothing is saved until then.");
    }
    const locked = !pro || !secure;

    new Setting(el)
      .setName('Turn on Ask')
      .setDesc("Off until you turn it on. While it's off, Reading Vault never goes online, apart from downloads you start yourself (the voice and the dictionary).")
      .addToggle((t) => {
        t.setValue(!!st.askEnabled && !locked);
        t.setDisabled(locked);
        if (t.toggleEl) t.toggleEl.disabled = locked;
        t.onChange(async (value) => { st.askEnabled = value; await plugin.saveSettings(); this.redraw(); });
      });

    new Setting(el)
      .setName('Which service answers')
      .setDesc("Only services you've added a key for can be picked.")
      .addDropdown((d) => {
        for (const p of ASK_PROVIDER_IDS) d.addOption(p, ASK_PROVIDERS[p].label);
        for (const opt of d.selectEl.options) opt.disabled = !locked && !plugin.askKey(opt.value) && opt.value !== st.askProvider;
        d.setValue(ASK_PROVIDERS[st.askProvider] ? st.askProvider : 'anthropic');
        d.setDisabled(locked);
        d.selectEl.disabled = locked;
        d.onChange(async (value) => { st.askProvider = value; await plugin.saveSettings(); this.redraw(); });
      });

    const where = {
      anthropic: 'From console.anthropic.com, under API keys. This is separate from a Claude app subscription.',
      openai: 'From platform.openai.com, under API keys. This is separate from a ChatGPT subscription.',
      openrouter: 'From openrouter.ai, under Keys. One key reaches many different AI models.',
    };
    this.askStatus = this.askStatus || {};
    for (const p of ASK_PROVIDER_IDS) {
      const saved = !locked && !!plugin.askKey(p);
      const row = new Setting(el).setName(`${ASK_PROVIDERS[p].short} key`).setDesc(where[p]);
      row.settingEl.addClass('a4r-settings-key');
      if (p === st.askProvider) row.settingEl.addClass('is-active');
      row.addText((t) => {
        t.inputEl.type = 'password';
        t.inputEl.autocomplete = 'off';
        t.inputEl.spellcheck = false;
        t.inputEl.setAttribute('aria-label', `${ASK_PROVIDERS[p].short} key`);
        t.setPlaceholder(locked ? 'Available in Pro' : saved ? 'Key saved. Paste a new one to replace it.' : `Paste your ${ASK_PROVIDERS[p].short} key`);
        t.setDisabled(locked);
        t.inputEl.disabled = locked;
        // Saved when the box loses focus or Enter is pressed, never per keystroke.
        t.inputEl.addEventListener('change', async () => {
          const v = t.inputEl.value.trim();
          if (!v) return;
          plugin.setAskKey(p, v);
          t.inputEl.value = '';
          this.askStatus[p] = null;
          // A first key picks its service, so Ask works without a second step.
          if (!plugin.askKey(st.askProvider) || st.askProvider === p) { st.askProvider = p; await plugin.saveSettings(); }
          this.redraw();
        });
      });
      row.addButton((b) => {
        b.setButtonText('Test');
        b.setDisabled(!saved || !st.askEnabled);
        if (saved && !st.askEnabled) setTooltip(b.buttonEl, 'Turn on Ask to test your key');
        b.onClick(async () => {
          this.askStatus[p] = { kind: 'busy', text: 'Checking…' };
          this.redraw();
          try {
            await plugin.askTestKey(p);
            this.askStatus[p] = { kind: 'ok', text: 'Works' };
          } catch (err) {
            this.askStatus[p] = { kind: 'bad', text: (err && err.message) || "Didn't work" };
          }
          this.redraw();
        });
      });
      // A key already stored can always be removed, even once Pro is off.
      if (saved || (locked && secure && !!plugin.askKey(p))) {
        row.addButton((b) => {
          b.setButtonText('Remove');
          b.onClick(() => { plugin.setAskKey(p, ''); this.askStatus[p] = null; this.redraw(); });
        });
      }
      const s = this.askStatus[p];
      const status = row.controlEl.createSpan({ cls: `a4r-settings-status is-${s ? s.kind : saved ? 'saved' : 'none'}` });
      status.setText(s ? s.text : saved ? 'Saved' : 'Not added');
    }

    const p = st.askProvider;
    const models = (plugin.askModelCache && plugin.askModelCache[p]) || [];
    const current = plugin.askModel(p);
    new Setting(el)
      .setName('Model')
      .setDesc(models.length ? 'Which model answers your questions.' : 'The full list loads from the service you picked when you turn on Ask and press Test next to its key.')
      .addDropdown((d) => {
        const ids = models.map((m) => m.id);
        if (current && !ids.includes(current)) d.addOption(current, plugin.askModelInfo(p, current).name);
        for (const m of models) d.addOption(m.id, m.name);
        if (!current && !models.length) d.addOption('', 'Press Test to load the list');
        d.setValue(current || '');
        const off = locked || (!models.length && !current);
        d.setDisabled(off);
        d.selectEl.disabled = off;
        d.onChange(async (value) => {
          st.askModels = { ...(st.askModels || {}), [p]: value || null }; // never mutate the shared default object
          await plugin.saveSettings();
        });
      });

    const sendRow = (key, name, desc) => new Setting(el).setName(name).setDesc(desc).addToggle((t) => {
      t.setValue(!!st[key]);
      t.setDisabled(locked);
      if (t.toggleEl) t.toggleEl.disabled = locked;
      t.onChange(async (value) => { st[key] = value; await plugin.saveSettings(); });
    });
    sendRow('askSendHighlights', 'Send my highlights and notes', "Your highlights from this book and the notes on them.");
    sendRow('askSendTopics', 'Send linked Topic notes', "The Topic notes this book's highlights are linked to.");
    sendRow('askSendChapter', "Send the chapter I'm on", "The text of the current chapter (for a PDF, the pages around the one you're on), so it can answer about what you're reading right now. The whole book is never sent.");
  }

  voiceRow(grid, v, choice) {
    const plugin = this.plugin;
    const row = grid.createEl('label', { cls: 'a4r-settings-voice' });
    const cb = row.createEl('input', { type: 'checkbox' });
    cb.checked = choice.ticked.includes(v.id);
    cb.disabled = cb.checked && choice.ticked.length === 1;
    cb.onchange = async () => {
      if (cb.checked) {
        if (!choice.ticked.includes(v.id)) choice.ticked.push(v.id);
      } else {
        if (choice.ticked.length <= 1) { cb.checked = true; return; } // the last voice stays on
        choice.ticked = choice.ticked.filter((x) => x !== v.id);
        if (choice.default === v.id) choice.default = choice.ticked[0];
      }
      await plugin.saveSettings();
      this.refreshReaders();
      this.redraw();
    };
    row.createSpan({ cls: 'a4r-settings-vname', text: v.name });
    if (v.best) row.createSpan({ cls: 'a4r-settings-best', text: 'Best' });
    row.createSpan({ cls: 'a4r-settings-accent', text: v.accent });
    const play = row.createEl('button', { cls: 'a4r-settings-play' });
    play.dataset.voiceId = v.id;
    this.setPlayButton(play, plugin.previewId === v.id);
    play.onclick = (e) => {
      e.preventDefault();
      if (plugin.previewId === v.id) { plugin.stopPreview(); return; }
      plugin.previewVoice(v.id).catch((err) => {
        if (err && err.message === KOKORO_CANCELLED) return;
        console.error('Reading Vault: voice preview failed', err);
        new Notice('That voice could not play a sample.');
      });
    };
  }

  // Reading Vault Pro (v0.17.0), built to the approved mockup-pro-key.html: buy
  // Pro, paste the key once, Pro for life. "Buy Pro" shows only once a store
  // page exists (PRO_BUY_URL); until the signing key is set up on John's Mac
  // everyone has Pro and this says so.
  proSettings(el) {
    const plugin = this.plugin;
    const head = new Setting(el).setName('Reading Vault Pro').setHeading();
    head.nameEl.createSpan({ cls: 'a4r-dash-pro a4r-settings-pro-badge', text: 'Pro' });
    if (!plugin.proPublicKeys().length) {
      if (PRO_BUILD === 'local') new Setting(el).setName('Pro is unlocked').setDesc('Everyone has Pro in this copy of Reading Vault while Pro keys are being set up.');
      else new Setting(el).setName('Pro is not available yet').setDesc(`Pro keys are not set up in this copy of Reading Vault. Contact ${PRO_SUPPORT_EMAIL}.`);
      return;
    }
    const lic = plugin.proLicense();
    if (lic) {
      const s = new Setting(el)
        .setName('Pro is unlocked')
        .setDesc('For life, including every future update. Thank you for supporting Reading Vault.');
      const st = s.descEl.createDiv({ cls: 'a4r-settings-pro-status' });
      st.createSpan({ cls: 'a4r-settings-dot' });
      st.createEl('b', { text: `Pro key #${lic.serial}` });
      s.addButton((b) => b.setButtonText('Remove key').onClick(async () => {
        await plugin.removeProKey();
        new Notice('Pro key removed from this computer.');
        this.redraw();
      }));
      return;
    }
    const get = new Setting(el).setName('Get Pro').setDesc('One payment, Pro for life, every future update included.');
    const perks = get.descEl.createEl('ul', { cls: 'a4r-settings-perks' });
    for (const p of PRO_PERKS) perks.createEl('li', { text: p });
    if (PRO_BUY_URL) get.addButton((b) => b.setButtonText('Buy Pro ↗').setCta().onClick(() => window.open(PRO_BUY_URL)));

    const keySetting = new Setting(el).setName('Pro key').setDesc('Paste the key from your purchase email. It starts with RVPK-.');
    keySetting.settingEl.addClass('a4r-settings-pro-key');
    const box = keySetting.settingEl.createDiv({ cls: 'a4r-settings-keybox' });
    const input = box.createEl('input', { type: 'text', attr: { placeholder: 'RVPK-…', 'aria-label': 'Pro key', spellcheck: 'false' } });
    const btn = box.createEl('button', { text: 'Unlock Pro' });
    const msg = keySetting.settingEl.createDiv({ cls: 'a4r-settings-keymsg' });
    const unlock = async () => {
      btn.disabled = true;
      let res;
      try { res = await plugin.setProKey(input.value); } catch (err) {
        console.error('Reading Vault: could not save the Pro key', err);
        res = { ok: false, reason: "Couldn't save the key. Try again." };
      }
      btn.disabled = false;
      if (!res.ok) {
        msg.setText(res.reason.replace('contact support', `contact ${PRO_SUPPORT_EMAIL}`));
        return;
      }
      new Notice('Reading Vault Pro is unlocked. Thank you!');
      this.redraw();
    };
    btn.onclick = unlock;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });
  }

  // Without Pro (v0.16.0, built to the approved mockup-pro-locks.html): the
  // natural voices as a Pro card. They can be downloaded and every voice
  // can be heard with ▶, but only Pro reads books with them.
  naturalVoicesProCard(el) {
    const plugin = this.plugin;
    const card = el.createDiv({ cls: 'a4r-settings-pro-card' });
    const t = card.createDiv({ cls: 'a4r-settings-pro-title' });
    t.appendText('Natural voices');
    t.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });
    card.createEl('p', { text: `${KOKORO_ALL_VOICES.length} natural-sounding English voices that sound much closer to a person reading. They work offline after a one-time download. With Pro, they replace the Mac voices above. Press ▶ to hear one.` });
    const infos = KOKORO_ALL_VOICES.map((k) => plugin.voiceInfo(`kokoro:${k[0]}`)).filter(Boolean);
    const grid = card.createDiv({ cls: 'a4r-settings-grid a4r-settings-samples' });
    for (const v of infos) {
      const row = grid.createDiv({ cls: 'a4r-settings-voice' });
      row.createSpan({ cls: 'a4r-settings-vname', text: v.name });
      if (v.best) row.createSpan({ cls: 'a4r-settings-best', text: 'Best' });
      row.createSpan({ cls: 'a4r-settings-accent', text: v.accent });
      const play = row.createEl('button', { cls: 'a4r-settings-play' });
      play.dataset.voiceId = v.id;
      this.setPlayButton(play, plugin.previewId === v.id);
      play.onclick = (e) => {
        e.preventDefault();
        if (plugin.previewId === v.id) { plugin.stopPreview(); return; }
        plugin.previewVoice(v.id).catch((err) => {
          if (err && err.message === KOKORO_CANCELLED) return;
          console.error('Reading Vault: voice preview failed', err);
          new Notice('That voice could not play a sample.');
        });
      };
    }
    this.kokoroRow(card);
  }

  kokoroRow(el) {
    const plugin = this.plugin;
    const st = plugin.kokoroStatus();
    const s = new Setting(el)
      .setName('Natural voices (Kokoro)')
      .setDesc('The voices need one download of about 90 MB. It is kept on this Mac, outside your vault, so it doesn\'t sync to your phone or get backed up with your notes.');
    const status = s.controlEl.createSpan({ cls: 'a4r-settings-status' });
    if (!st.installed) {
      status.setText('Not set up on this Mac');
      return;
    }
    if (this.downloading) {
      status.setText('Downloading…');
    } else if (st.downloaded) {
      status.createSpan({ cls: 'a4r-settings-dot' });
      status.createEl('b', { text: 'Downloaded' });
      status.createSpan({ cls: 'a4r-settings-size', text: `· ${Math.round(st.bytes / 1048576)} MB` });
    } else {
      status.setText('Not downloaded');
    }
    s.addButton((b) => {
      b.setButtonText(st.downloaded ? 'Download again' : 'Download (88 MB)');
      b.setDisabled(!!this.downloading);
      b.onClick(async () => {
        this.downloading = true;
        this.redraw();
        try {
          await plugin.kokoroRedownload();
          new Notice('The Kokoro voice is downloaded.');
        } catch (err) {
          console.error('Reading Vault: Kokoro download failed', err);
          new Notice('The Kokoro voice could not be downloaded. Check the internet connection and try again.');
        }
        this.downloading = false;
        if (this.containerEl.isConnected) this.redraw();
      });
    });
  }

  // Redraw without the page jumping back to the top: Obsidian scrolls the
  // settings content (or its container), and empty() resets that scroll.
  // A download or key test that finishes after Settings was closed
  // doesn't rebuild the closed page (QA fix v0.17.3).
  redraw() {
    if (!this.shown) return;
    const scrollers = [this.containerEl, this.containerEl.parentElement].filter(Boolean);
    const saved = scrollers.map((el) => el.scrollTop);
    this.display();
    scrollers.forEach((el, i) => { el.scrollTop = saved[i]; });
  }

  // ▶ while idle, ■ while this voice's sample plays (click to stop).
  setPlayButton(btn, playing) {
    btn.setText(playing ? '■' : '▶');
    btn.setAttribute('aria-label', playing ? 'Stop the sample' : 'Hear a sample');
    btn.toggleClass('a4r-playing', playing);
  }

  // Folders (v0.18.0), built to the approved docs/mockups/mockup-folders.html:
  // three folder boxes with suggestions from the vault, a live "Where things
  // go" example, and -- when a changed folder already holds books -- the
  // "Move them?" window with a count first.
  foldersSection(el) {
    const plugin = this.plugin;
    new Setting(el).setName('Folders').setHeading();
    el.createEl('p', { cls: 'a4r-settings-intro', text: 'Where Reading Vault keeps things in your vault. Everything is a regular note or file, so you can open it in Obsidian like anything else.' });
    const rows = [
      ['reading', 'Reading folder', 'A note for each book. Highlights and saved words go in folders inside it.', 'Reading folder'],
      ['topics', 'Topics folder', 'Where the Topic notes you link highlights to live. Use a folder you already have, or a new one.', 'Topics folder'],
      ['files', 'Book files and covers', 'The EPUB and PDF files themselves, and their cover images.', 'Book files and covers folder'],
    ];
    const inputs = {};
    const tree = createDiv({ cls: 'a4r-folder-tree' });
    const drawTree = () => {
      tree.empty();
      const v = (k) => cleanFolderPath(inputs[k].value) || plugin.folderSettings()[k];
      tree.createSpan({ cls: 'a4r-folder-tree-c', text: 'Where things go' });
      const line = (dir, name, note) => {
        const row = tree.createDiv();
        row.createSpan({ cls: 'a4r-folder-tree-hl', text: `${dir}/` });
        row.appendText(name);
        if (note) row.createSpan({ cls: 'a4r-folder-tree-c', text: ` ${note}` });
      };
      line(v('reading'), 'Walden.md', 'a book note');
      line(`${v('reading')}/Highlights`, 'Our life is frittered away.md');
      line(`${v('reading')}/Words`, 'fritter.md');
      line(v('topics'), 'Simplicity.md', 'a Topic note');
      line(`${v('files')}/Books`, 'walden.epub');
      line(`${v('files')}/Covers`, 'walden.jpg');
    };
    for (const [kind, name, desc, label] of rows) {
      const row = new Setting(el).setName(name).setDesc(desc);
      row.settingEl.addClass('a4r-settings-folder');
      row.addText((t) => {
        inputs[kind] = t.inputEl;
        t.inputEl.setAttribute('aria-label', label);
        t.inputEl.spellcheck = false;
        t.inputEl.autocomplete = 'off';
        t.setValue(plugin.folderSettings()[kind]);
        this.wireFolderSuggest(t.inputEl, (value) => this.commitFolder(kind, value, t.inputEl), drawTree);
      });
    }
    el.appendChild(tree);
    drawTree();
  }

  // The box's suggestions: what's typed (marked "new folder" when it isn't
  // one yet), then existing folders that match. Picking one, Enter, or
  // leaving the box saves it.
  wireFolderSuggest(input, commit, onType) {
    const wrap = input.parentElement;
    wrap.addClass('a4r-folder-field');
    let box = null;
    let items = [];
    let at = 0;
    const close = () => { if (box) { box.remove(); box = null; } };
    const folders = () => this.app.vault.getAllLoadedFiles()
      .filter((f) => f.children && f.path && f.path !== '/' && !f.path.startsWith('.'))
      .map((f) => f.path).sort((a, b) => a.localeCompare(b));
    const open = () => {
      close();
      const typed = cleanFolderPath(input.value);
      const q = String(input.value || '').trim().toLowerCase();
      const all = folders();
      items = [];
      if (typed && !all.includes(typed)) items.push({ path: typed, isNew: true });
      for (const p of all) if (!q || p.toLowerCase().includes(q)) items.push({ path: p, isNew: false });
      items = items.slice(0, 8);
      if (!items.length) return;
      at = 0;
      box = wrap.createDiv({ cls: 'a4r-folder-suggest' });
      items.forEach((it, i) => {
        const row = box.createDiv({ cls: `a4r-folder-suggest-item${i === at ? ' is-on' : ''}` });
        row.appendText(it.path);
        if (it.isNew) row.createEl('small', { text: ' (new folder)' });
        row.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = it.path; close(); onType(); commit(it.path); });
      });
    };
    const mark = () => { if (box) Array.from(box.children).forEach((c, i) => c.toggleClass('is-on', i === at)); };
    input.addEventListener('input', () => { onType(); open(); });
    input.addEventListener('focus', open);
    input.addEventListener('blur', () => { close(); commit(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && box) { e.preventDefault(); at = Math.min(items.length - 1, at + 1); mark(); }
      else if (e.key === 'ArrowUp' && box) { e.preventDefault(); at = Math.max(0, at - 1); mark(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (box && items[at]) input.value = items[at].path;
        close();
        onType();
        commit(input.value);
      } else if (e.key === 'Escape' && box) { e.preventDefault(); e.stopPropagation(); close(); }
    });
  }

  async commitFolder(kind, raw, input) {
    const plugin = this.plugin;
    const current = plugin.folderSettings();
    const from = current[kind];
    // Enter and then leaving the box both commit: one question at a time.
    if (this._folderBusy || this._folderAsking) return;
    const to = cleanFolderPath(raw);
    const back = () => { input.value = from; this.redraw(); };
    if (to === from) { input.value = from; return; }
    if (!to) { new Notice('That folder name can\'t be used. Try letters, numbers and spaces, with "/" between folders.'); back(); return; }
    const other = kind === 'reading' ? current.topics : kind === 'topics' ? current.reading : null;
    if (other && to === other) { new Notice('The Reading and Topics folders need to be different.'); back(); return; }
    const { counts } = plugin.folderContents(kind);
    const total = counts.reduce((n, [c]) => n + c, 0);
    const save = async (move) => {
      this._folderBusy = true;
      try {
        const res = await plugin.changeFolder(kind, to, { move });
        if (move) new Notice(`Moved ${folderMoveSummary(kind, counts)} to ${to}.`);
        else new Notice(`Reading Vault now uses "${to}".`);
        return res;
      } catch (err) {
        console.error('Reading Vault: changing a folder failed', err);
        new Notice('That didn\'t work. Nothing was deleted; see the note in the console.');
        return null;
      } finally {
        this._folderBusy = false;
        this.redraw();
      }
    };
    if (!total) { await save(false); return; }
    this._folderAsking = true;
    new FolderMoveModal(this.app, {
      kind, from, to, counts,
      onMove: () => { this._folderAsking = false; return save(true); },
      onBack: () => { this._folderAsking = false; back(); },
    }).open();
  }

  // Any open reader picks up voice/language changes straight away.
  refreshReaders() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => { if (leaf.view && leaf.view.updateListenBarUI) leaf.view.updateListenBarUI(); });
  }

  hide() {
    this.shown = false;
    this.plugin.stopPreview();
    this.plugin.onPreviewChange = null;
    if (window.speechSynthesis && this.listeningForVoices) window.speechSynthesis.removeEventListener('voiceschanged', this.onVoicesChanged);
    this.listeningForVoices = false;
  }
}

// ---------------- reading-session recording (2026-09-23 proof of concept) ----------------
//
// Background logging of reading sessions, so a future PAID Reading dashboard
// has real history to read once it's built (not built in this pass -- see
// the brief). One record per contiguous stretch of the SAME book + mode
// (read/listen). Lives in this plugin's own storage, `sessions.json` next
// to `data.json` (via the vault adapter, never a vault note and never
// `data.json` itself), so Obsidian Sync only ever sees one small,
// infrequently-written file -- never book/highlight notes, and never a
// write when nothing actually changed.
//
// On-disk format (documented here for whoever builds the dashboard):
//   { "version": 1, "sessions": [
//     { "book": { "path": "<book note path>", "title": "<book title>" },
//       "mode": "read" | "listen",
//       "start": "<ISO 8601>", "end": "<ISO 8601>",
//       "activeMinutes": <number, 1 decimal>, "pages": <integer> },
//     ... ] }
// Sessions are appended in start order. The one currently in progress (if
// any) is the last element with `end` still equal to `start` -- everything
// before it is finished. A session under SESSION_NOISE_MIN_MINUTES with 0
// pages moved (e.g. opening the Reader and leaving at once) is dropped
// rather than written.
class SessionRecorder {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.sessions = [];
    this.cur = null; // { rec, lastActive, lastTick, lastPersistAt }
  }

  get filePath() { return `${this.plugin.manifest.dir}/${SESSION_FILE_NAME}`; }

  async load() {
    const adapter = this.app.vault.adapter;
    let raw = null;
    this.readBlocked = false;
    let exists = true;
    try {
      if (typeof adapter.exists === 'function') exists = await adapter.exists(this.filePath);
    } catch { exists = true; } // unsure: treat as there, never overwrite blindly
    if (!exists) { this.sessions = []; return; } // no history yet
    try {
      raw = await adapter.read(this.filePath);
    } catch (err) {
      // The file is there but couldn't be read right now (a sync or iCloud
      // moment). QA fix (v0.17.3): starting empty and saving would replace
      // the real history, so nothing is saved this session; it reads
      // normally next time Obsidian starts.
      this.sessions = [];
      this.readBlocked = true;
      console.error('Reading Vault: reading history could not be read; not saving over it this session', err);
      return;
    }
    try {
      const data = JSON.parse(raw);
      this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    } catch (err) {
      // QA fix (v0.17.2): a damaged history file (a crash mid-save, a sync
      // conflict) used to be replaced by an empty one on the next save,
      // losing every day of reading. Keep a copy first.
      this.sessions = [];
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      const backup = `${this.filePath}.damaged-${stamp}`;
      try {
        await adapter.write(backup, raw);
        new Notice(`Reading Vault: your reading history file couldn't be read, so a copy was kept as ${backup.split('/').pop()} and a new history was started.`, 15000);
      } catch (e) { console.error('Reading Vault: could not keep a copy of the damaged reading history', e); }
      console.error('Reading Vault: reading history could not be read', err);
    }
    // A session left open by a crash/force-quit already has a real `end`
    // -- its own last crash-guard write (see tick()), or `start` itself if
    // it crashed before the first one -- so nothing needs closing out here;
    // a fresh noteActivity() after restart simply starts the next session.
  }

  async persist() {
    if (this.readBlocked) return;
    try {
      await this.app.vault.adapter.write(this.filePath, JSON.stringify({ version: 1, sessions: this.sessions }));
    } catch (err) { console.error('Reading Vault: could not save reading sessions', err); }
    // Reading Dashboard (v0.8.0): an open dashboard redraws when a session
    // is saved. History is never pruned here -- the dashboard's calendar,
    // streaks and yearly numbers need every session ever recorded.
    if (typeof this.plugin.refreshDashboards === 'function') this.plugin.refreshDashboards();
  }

  // A real activity signal: a real user scroll while reading (mode 'read',
  // pages: 0), or audio starting to play (mode 'listen', pages: 0). A hand
  // page turn goes through notePageTurn() below instead, which gates
  // whether it counts toward `pages` -- noteActivity() itself no longer
  // decides that. Starts a new session if none is running, or the
  // book/mode changed (a book change or a read<->listen switch is always a
  // new session, per the brief); otherwise just refreshes the running one
  // so tick()'s idle check doesn't end it.
  noteActivity(book, mode, pages = 0) {
    if (!book || !book.path) return;
    const now = Date.now();
    if (this.cur && (this.cur.rec.book.path !== book.path || this.cur.rec.mode !== mode)) this.endCurrent();
    if (!this.cur) {
      const iso = new Date(now).toISOString();
      const rec = { book, mode, start: iso, end: iso, activeMinutes: 0, pages: 0 };
      this.sessions.push(rec);
      this.cur = { rec, lastActive: now, lastTick: now, lastPersistAt: 0 };
    }
    this.cur.lastActive = now;
    this.cur.rec.pages += pages;
  }

  // notePageTurn — a hand page turn (› / ‹ / arrow keys, EPUB or PDF). Fixes
  // the 2026-09-23 pace bug: flipping pages fast (skimming, or mashing a
  // stuck/failed turn -- e.g. the "P.41 of 42" freeze fixed the same day)
  // was counting every click as a full page toward computeReadingPace(),
  // making the reader look like it reads unrealistically fast and crashing
  // "time left in book" (9h21m -> 5h56m while paging, no real reading in
  // between). Always registers real activity via noteActivity() (keeps the
  // session alive), but only counts the page toward `pages` -- the number
  // computeReadingPace() divides real minutes by -- when at least
  // MIN_PAGE_TURN_MS has passed since the last page that counted; a faster
  // one is skimming or a failed/no-op turn, not a page actually read.
  notePageTurn(book, mode) {
    if (!book || !book.path) return;
    // Turning pages while the voice reads this book is part of listening:
    // it no longer ends the listening session and starts a short reading
    // one with "skimmed" pages (QA fix v0.17.3).
    if (mode === 'read' && this.cur && this.cur.rec.mode === 'listen' && this.cur.rec.book.path === book.path) {
      this.cur.lastActive = Date.now();
      return;
    }
    this.noteActivity(book, mode, 0);
    const c = this.cur;
    if (!c) return;
    const now = Date.now();
    const last = c.lastCountedPageTurnAt || 0;
    if (now - last >= MIN_PAGE_TURN_MS) {
      c.rec.pages += 1;
      c.lastCountedPageTurnAt = now;
    }
  }

  // Called every SESSION_TICK_MS regardless of whether the Reader is even
  // open -- a no-op with nothing running. isPlaying is a live check (not a
  // stored flag) of whether audio is actually sounding right now.
  tick(isPlaying) {
    if (!this.cur) return;
    const now = Date.now();
    const c = this.cur;
    if (c.rec.mode === 'listen') {
      if (!isPlaying) { this.endCurrent(); return; }
      c.lastActive = now;
    } else if (now - c.lastActive > SESSION_IDLE_MS) {
      this.endCurrent();
      return;
    }
    // Capped so a sleeping/suspended Mac can't silently credit hours it
    // was never actually open for.
    const elapsedMs = Math.max(0, Math.min(now - c.lastTick, SESSION_TICK_MS * 2));
    c.lastTick = now;
    c.rec.activeMinutes = Math.round(((c.rec.activeMinutes * 60000 + elapsedMs) / 60000) * 10) / 10;
    if (now - c.lastPersistAt > SESSION_CRASH_GUARD_MS) { c.lastPersistAt = now; c.rec.end = new Date(now).toISOString(); this.persist(); }
  }

  // Ends whatever session is running (book change, leaving the Reader, long
  // idle, or listening actually stopping). Safe to call with nothing
  // running. A session too short to be worth keeping is dropped instead of
  // written.
  endCurrent() {
    if (!this.cur) return;
    const { rec } = this.cur;
    this.cur = null;
    rec.end = new Date(Date.now()).toISOString();
    if (rec.activeMinutes < SESSION_NOISE_MIN_MINUTES && rec.pages === 0) {
      const i = this.sessions.indexOf(rec);
      if (i >= 0) this.sessions.splice(i, 1);
      return;
    }
    // Flip-through-noise guard (2026-09-23 pace fix): notePageTurn()
    // already excludes any single page turned faster than MIN_PAGE_TURN_MS
    // from `pages`, but a whole SESSION can still average out implausibly
    // fast (e.g. real minutes barely ticked up because the tick() clock
    // caught it right at a boundary, while several pages each individually
    // cleared the per-turn gate). Flagged, not deleted -- todayTotals()
    // still shows the real minutes/pages turned; only computeReadingPace()
    // excludes it, so a stretch of skimming/misfires can never drag the
    // book's pace estimate down.
    rec.implausiblePace = rec.mode === 'read' && rec.pages > 0
      && (rec.activeMinutes / rec.pages) < SESSION_MIN_PLAUSIBLE_MIN_PER_PAGE;
    this.persist();
  }

  todayTotals() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    let readMin = 0;
    let listenMin = 0;
    let pages = 0;
    const books = new Set();
    for (const s of this.sessions) {
      if (new Date(s.start) < startOfDay) continue;
      if (s.mode === 'listen') listenMin += s.activeMinutes; else readMin += s.activeMinutes;
      pages += s.pages;
      books.add(s.book.path);
    }
    return { readMin, listenMin, pages, books: books.size };
  }

  // Command palette: "Reading Vault: Today's reading" -- the proof this all
  // actually works, per the brief.
  showToday() {
    const round1 = (n) => Math.round(n * 10) / 10;
    const t = this.todayTotals();
    if (t.books === 0) { new Notice("No reading recorded yet today."); return; }
    new Notice(`Today's reading: ${round1(t.readMin)} min read, ${round1(t.listenMin)} min listened, ${t.pages} page(s) turned, across ${t.books} book(s).`, 8000);
  }
}

// ===========================================================================
// Reading Dashboard (v0.8.0) -- built to the approved mockup
// (03 WiP/2026-09-22-a4-reading-four-basics/mockup-reading-dashboard.html,
// approved 2026-09-23). Everything here is READ from the SessionRecorder's
// sessions (sessions.json) and the book notes' own frontmatter; the only
// things it writes are the plugin's own goal settings (data.json).
//
// Rules carried over from the recorder / Reader:
//   - Days split on the LOCAL time zone (sessions are stored as UTC ISO
//     strings; a session belongs to the local day it STARTED on).
//   - A session flagged implausiblePace (v0.7.2 flip-through guard) counts
//     as time, never as pages read or toward pace; its pages show only as
//     "skimmed pages not counted".
//   - Days before the first recorded session are "before recording
//     started" (hatched), never shown as days skipped.
//   - No example data anywhere in the product.
// ===========================================================================
const DASHBOARD_VIEW_TYPE = 'a4-reading-dashboard';
// Pro gating is an OPEN launch decision (checkout/licence not chosen yet,
// 2026-09-23). One internal flag, ON for now so John gets the full
// dashboard. No licence check exists yet on purpose. With it off, the
// dashboard shows a locked notice and the Library strip shows the
// mockup's "in Pro" line.
const DASHBOARD_PRO_UNLOCKED = true;

// ---------------- Pro key (v0.17.0, hardened v0.18.2) ----------------
// A Pro key is a numbered key with a signature:
//   RVPK-K<6 digits>.<86-character base64url Ed25519 signature>
// e.g. RVPK-K483921.… (99 characters, under Payhip's 100). The signature is
// Ed25519 over the text "K<6 digits>", made with the private key that only
// John's Mac holds (scripts/pro-keys.js). The plugin checks it on this
// computer with the public keys below: no internet, no expiry, so Pro and
// every future update stay unlocked for life (John, 2026-09-24).
//
// Strict on purpose (v0.18.2): exactly one spelling of each key is accepted
// (no stray characters, no alternative spelling of the last signature
// character), and a key IS its serial number: revocation and anything else
// that tells keys apart goes by the serial, never the key text. The older
// email-in-the-key format was retired before any key existed.
//
// PRO_PUBLIC_KEYS is a list so a lost signing key can be replaced by a new
// one without breaking keys already sold: `npm run pro:init` adds a public
// key to the end and never removes one. Empty until it is run once on
// John's Mac. Keep each entry on this one line (the script rewrites it).
const PRO_PUBLIC_KEYS = [];
// Serial numbers of keys that no longer unlock Pro (a key posted online, a
// refund). Numbers only, e.g. [483921]. Only copies that update are affected.
const PRO_REVOKED_SERIALS = [];
// Which kind of copy this is. 'local' = John's own vault: while there are no
// public keys yet, everyone has Pro (DASHBOARD_PRO_UNLOCKED). 'public' = a
// copy for sale: with no public key Pro stays locked, and
// scripts/check-release.js (run by npm test, CI, deploy and
// `npm run release:check`) fails loudly, so a public build can't ship
// without keys.
const PRO_BUILD = 'public';
const PRO_KEY_PREFIX = 'RVPK-';
const PRO_KEY_RE = /^RVPK-K(\d{6})\.([A-Za-z0-9_-]{86})$/;
// The store page "Buy Pro" opens. Empty until John picks a store; the
// button only shows once this is set.
const PRO_BUY_URL = 'https://payhip.com/WorkbenchGoods';
// For "contact support" when a key doesn't work (John, 2026-09-24).
const PRO_SUPPORT_EMAIL = 'jhesch@gmail.com';
const PRO_PERKS = ['Natural-sounding voices', 'Reading Dashboard', 'Highlight review', 'Ask the book', 'Book summaries', 'Saving words', 'Export highlights', 'Explain a word in its sentence'];

function b64urlToBuf(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
}

function bufToB64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// { ok: true, serial } or { ok: false, reason } -- reason in plain words for
// the Settings page. Spaces and line breaks (from copying out of an email)
// are removed first; after that only the one exact spelling is accepted.
function verifyProKey(key, publicKeys, revoked = PRO_REVOKED_SERIALS) {
  const bad = (reason) => ({ ok: false, reason });
  const raw = String(key || '').replace(/\s+/g, '');
  if (!raw) return bad('Paste your Pro key first.');
  if (!raw.startsWith(PRO_KEY_PREFIX)) return bad("That doesn't look like an Reading Vault Pro key. It starts with RVPK-.");
  const keys = (Array.isArray(publicKeys) ? publicKeys : [publicKeys]).filter(Boolean);
  if (!keys.length) return bad('Pro keys are not set up in this copy of Reading Vault yet.');
  const m = PRO_KEY_RE.exec(raw);
  if (!m) return bad(raw.length < 99 ? 'That key looks incomplete. Copy the whole key and try again.' : "That key isn't valid. Check it was copied exactly, or contact support.");
  const sig = b64urlToBuf(m[2]);
  // One spelling only: the signature must decode to 64 bytes and encode back
  // to exactly the same text (rules out the spare bits in the last character).
  if (sig.length !== 64 || bufToB64url(sig) !== m[2]) return bad("That key isn't valid. Check it was copied exactly, or contact support.");
  const payload = Buffer.from(`K${m[1]}`, 'utf8');
  const valid = keys.some((pem) => {
    try { return crypto.verify(null, payload, pem, sig); } catch { return false; }
  });
  if (!valid) return bad("That key isn't valid. Check it was copied exactly, or contact support.");
  const serial = Number(m[1]);
  if ((revoked || []).map(Number).includes(serial)) return bad('This key has been turned off. If you think that is a mistake, contact support.');
  return { ok: true, serial: String(serial) };
}
// Highlight review is Pro too (John, 2026-09-24); one switch for both.
const REVIEW_PRO_UNLOCKED = DASHBOARD_PRO_UNLOCKED;
const DASH_PAUSED_AFTER_DAYS = 14; // an unfinished book untouched this long shows as "paused"
const DASH_HEAT_WEEKS = 26;
const DASH_CHART_DAYS = 30;
const DASH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DASH_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// Highlight review (v0.9.0) -- spaced review of linked highlights, built to
// the approved mockup docs/mockups/mockup-highlight-review.html (John,
// 2026-09-24). John's decisions: "Just reread" is the default card, with
// "Remember first" as a setting; only highlights linked to a Topic are
// reviewed; the schedule lives on each highlight note's own frontmatter;
// "Add a thought" adds to that highlight's own note; it is a Pro feature.
//
// Schedule fields on a book_highlight note (in GL-002 since 2026-09-24):
//   review_due       "YYYY-MM-DD", the local day it next comes back
//   review_interval  days between the last review and review_due; 0 means
//                    "Stop showing this one" (review_due is then removed)
//   review_count     how many times it has been reviewed
// A linked highlight with none of these has never been reviewed and is due.
// ---------------------------------------------------------------------------
const REVIEW_PER_DAY_CHOICES = [3, 5, 10, 15, 20];

function isReviewStopped(h) {
  return h.review_interval !== undefined && h.review_interval !== null && Number(h.review_interval) === 0;
}

function reviewDueKey(h) {
  return h.review_due ? String(h.review_due).slice(0, 10) : null;
}

// Linked, not stopped. Dismissed/pending highlights never enter review.
function isInReview(h) {
  return h.status === 'linked' && !isReviewStopped(h);
}

// Everything due on or before `dayKey`, most overdue first, then highlights
// never reviewed (oldest highlight first). Not capped -- see planReviewQueue.
function dueForReview(highlights, dayKey) {
  const due = highlights.filter((h) => {
    if (!isInReview(h)) return false;
    const k = reviewDueKey(h);
    return !k || k <= dayKey;
  });
  return due.sort((a, b) => {
    const ka = reviewDueKey(a), kb = reviewDueKey(b);
    if (ka && kb) return ka.localeCompare(kb);
    if (ka) return -1;
    if (kb) return 1;
    return String(a.highlighted_at || '').localeCompare(String(b.highlighted_at || ''));
  });
}

// Today's set: at most `perDay` a day, minus any already reviewed today.
// Anything left over waits; it never piles up into a bigger day.
function planReviewQueue(highlights, dayKey, perDay, doneToday) {
  const room = Math.max(0, (perDay || 5) - (doneToday || 0));
  return dueForReview(highlights, dayKey).slice(0, room);
}

// The three "When should this come back?" choices, in days. `interval` is
// the highlight's current gap (1 for a highlight never reviewed).
function reviewChoices(interval) {
  const base = Math.max(1, Number(interval) || 1);
  return [
    { key: 'sooner', label: 'Sooner', days: Math.max(1, Math.round(base / 3)) },
    { key: 'good', label: 'Good', days: Math.max(2, Math.round(base * 2.5)) },
    { key: 'easy', label: 'Know it well', days: Math.max(4, Math.round(base * 4)) },
  ];
}

function fmtReviewGap(days) {
  if (days <= 1) return 'tomorrow';
  if (days < 7) return `in ${days} days`;
  if (days < 60) { const w = Math.round(days / 7); return `in ${w} ${w === 1 ? 'week' : 'weeks'}`; }
  const m = Math.round(days / 30);
  return `in ${m} ${m === 1 ? 'month' : 'months'}`;
}

// The day it was last reviewed, worked back from review_due - review_interval
// (both are always written together). null when never reviewed.
function reviewLastSeen(h) {
  const k = reviewDueKey(h);
  const n = Number(h.review_interval);
  if (!k || !(n > 0)) return null;
  return addLocalDays(parseDayKey(k), -n);
}

function fmtDaysAgo(day, today) {
  const n = Math.round((addLocalDays(today, 0) - addLocalDays(day, 0)) / 86400000);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n} days ago`;
}

// ---------------------------------------------------------------------------
// Ask the book (v0.10.0, Pro) -- questions about the open book, answered by
// the reader's own AI service from their own highlights, notes, linked Topic
// notes and the chapter they're on. Built to the approved mockup
// mockup-ask-the-book.html (John, 2026-09-24). John's decisions: a fourth
// "Ask" tab in the Reader's side panel; send highlights + notes, linked Topic
// notes and the current chapter (never the whole book); "Save to book note"
// keeps an answer; keys are kept in Obsidian's secure storage (the
// computer's own keychain on Mac and Windows), never in data.json; Pro; off
// until turned on in Settings, and a key can only be added with Pro.
//
// This is the ONLY feature besides the one-time Kokoro download that goes
// online, and only while `askEnabled` is on with a saved key. Calls go
// through Obsidian's requestUrl (no browser CORS limits), as raw HTTP: the
// plugin has no build step, so no provider SDK can be bundled.
// ---------------------------------------------------------------------------
const ASK_PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', short: 'Anthropic', secretId: 'a4-reading-anthropic-key', defaultModel: 'claude-sonnet-5' },
  openai: { label: 'OpenAI', short: 'OpenAI', secretId: 'a4-reading-openai-key', defaultModel: null },
  openrouter: { label: 'OpenRouter', short: 'OpenRouter', secretId: 'a4-reading-openrouter-key', defaultModel: null },
};
const ASK_PROVIDER_IDS = ['anthropic', 'openai', 'openrouter'];

// Anthropic list prices, US$ per million tokens [input, output], for the
// "about 1¢" line. Longest matching prefix wins. OpenRouter prices come live
// from its model list; OpenAI publishes none, so its answers show no cost.
const ANTHROPIC_PRICES = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5],
};

// How much of each kind of source goes into one question. Keeps a question
// to roughly a chapter's worth of reading (tens of thousands of tokens at
// most), which is what keeps the cost to about a cent or two.
const ASK_LIMITS = { highlights: 80, topicNotes: 8, topicChars: 6000, chapterChars: 60000, pdfPagesEachSide: 2 };

const ASK_SYSTEM_PROMPT = [
  'You answer questions about a book the reader is reading. You are given numbered sources: passages from the part of the book they are on, their own highlights and notes on this book, and their own Topic notes from their personal notes.',
  '',
  'Base your answer on the sources. Right after any sentence that relies on a source, cite it with its id in square brackets, like [S3] or [S2][S5]. Only cite ids that appear in the sources.',
  'You may add a little general knowledge about the book or its author when it genuinely helps, without a citation. If the sources do not cover the question, say so plainly rather than guessing.',
  'Refer to the reader\'s own material as "your highlight", "your note" or "your Topic note".',
  'Write in plain, warm English for someone with no specialist background: two to four short paragraphs, no headings, and no bullet lists unless the question asks for a list.',
].join('\n');

function askSourceLabel(s) {
  if (s.kind === 'chapter') return s.where ? `This book · ${s.where}` : 'This chapter';
  if (s.kind === 'highlight') return s.where ? `Your highlight · ${s.where}` : 'Your highlight';
  if (s.kind === 'note') return s.where ? `Your note on a highlight · ${s.where}` : 'Your note on a highlight';
  if (s.kind === 'topic') return `[[${s.title}]] Topic note`;
  return 'Source';
}

// The one user message: the book, every source with its id, then the question.
function buildAskMessage({ title, author, question, sources }) {
  const clean = (t) => String(t || '').replace(/<\/?source[^>]*>/gi, '').trim();
  const lines = [`Book: ${title}${author ? ` by ${author}` : ''}`, '', '<sources>'];
  for (const s of sources) lines.push(`<source id="${s.id}" kind="${askSourceLabel(s)}">\n${clean(s.text)}\n</source>`);
  lines.push('</sources>', '', `Question: ${String(question || '').trim()}`);
  return lines.join('\n');
}

// Turns "... [S3][S5] ..." into paragraphs of text runs and citation numbers,
// renumbered 1, 2, 3 in order of first use. Ids the model made up (not in
// `sources`) are dropped rather than shown as broken citations.
function parseAskAnswer(text, sources) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const used = [];
  const numberOf = new Map();
  const paragraphs = String(text || '').trim().split(/\n\s*\n/).map((para) => {
    const runs = [];
    let last = 0;
    const re = /\[((?:S\d+)(?:\s*[,;]\s*S\d+)*)\]/g;
    let m;
    while ((m = re.exec(para))) {
      if (m.index > last) runs.push({ text: para.slice(last, m.index) });
      for (const id of m[1].split(/\s*[,;]\s*/)) {
        const src = byId.get(id);
        if (!src) continue;
        if (!numberOf.has(id)) { used.push(src); numberOf.set(id, used.length); }
        runs.push({ cite: numberOf.get(id) });
      }
      last = re.lastIndex;
    }
    if (last < para.length) runs.push({ text: para.slice(last) });
    // Tidy the space a removed citation leaves before punctuation.
    for (let i = 0; i < runs.length; i += 1) {
      if (runs[i].text !== undefined && i > 0 && runs[i - 1].cite) runs[i].text = runs[i].text.replace(/^\s+(?=[.,;:!?)])/, '');
    }
    return runs.filter((r) => r.cite || r.text.replace(/\s+/g, ' ') !== '');
  }).filter((runs) => runs.length);
  return { paragraphs, used };
}

// Plain text of a parsed answer with its numbered sources -- what "Copy" and
// "Save to book note" write.
function askAnswerToMarkdown(parsed) {
  const body = parsed.paragraphs.map((runs) => runs.map((r) => (r.cite ? `[${r.cite}]` : r.text)).join('').replace(/[ \t]+\n/g, '\n').trim()).join('\n\n');
  const src = parsed.used.map((s, i) => `${i + 1}. "${truncate(String(s.text).replace(/\s+/g, ' '), 200)}" (${askSourceLabel(s)})`);
  return src.length ? `${body}\n\n${src.join('\n')}` : body;
}

function askAnthropicPrice(model) {
  let best = null;
  for (const k of Object.keys(ANTHROPIC_PRICES)) {
    if (String(model).startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? ANTHROPIC_PRICES[best] : null;
}

// [inputPerMillion, outputPerMillion] in US$ -> "under 1¢" / "about 3¢" / "about $0.12".
function fmtAskCost(inputTokens, outputTokens, price) {
  if (!price || !(inputTokens >= 0) || !(outputTokens >= 0)) return null;
  const dollars = (inputTokens * price[0] + outputTokens * price[1]) / 1e6;
  const cents = dollars * 100;
  if (cents < 1) return 'under 1¢';
  if (cents < 100) return `about ${Math.round(cents)}¢`;
  return `about $${dollars.toFixed(2)}`;
}

// A failed call, in plain words for the reader.
function askErrorMessage(provider, status) {
  const name = ASK_PROVIDERS[provider] ? ASK_PROVIDERS[provider].short : 'The service';
  if (status === 401 || status === 403) return `${name} didn't accept the key. Check it in Settings → Reading Vault.`;
  if (status === 402) return `${name} says the account needs more credit.`;
  if (status === 429) return `${name} says you've hit a limit. Try again in a minute.`;
  if (status === 404) return `${name} doesn't recognise the chosen model. Pick another in Settings → Reading Vault.`;
  if (!status) return `Couldn't reach ${name}. Check your internet connection.`;
  if (status >= 500) return `${name} is having trouble right now (error ${status}). Try again shortly.`;
  return `${name} returned an error (${status}).`;
}

// OpenAI's model list mixes chat models with speech, image and embedding
// ones; keep only what can answer a text question.
// "About N books by December" at this year's pace so far. Counted in
// calendar days, so the clocks changing in March doesn't make a day go
// missing (QA fix v0.17.3).
function projectBooksByYearEnd(finishedCount, today) {
  const year = today.getFullYear();
  const dayOfYear = Math.round((Date.UTC(year, today.getMonth(), today.getDate()) - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const daysInYear = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000);
  return Math.max(finishedCount, Math.round((finishedCount / dayOfYear) * daysInYear));
}

// QA fix v0.17.3: also leaves out models that can't take a chat question
// this way (older "instruct" ones, and the "pro", "codex", deep-research
// and computer-use ones), which answered with an error when picked.
function isOpenAiChatModel(id) {
  return /^(gpt-|o\d|chatgpt-)/.test(id)
    && !/(embedding|tts|whisper|dall-e|moderation|audio|realtime|image|transcribe|search|instruct|codex|deep-research|computer-use)/.test(id)
    && !/-pro(?:-|$)/.test(id);
}

// ---------------------------------------------------------------------------
// Export highlights (v0.11.0, free) -- one file of your highlights and notes,
// built to the approved mockup-export-highlights.html (John, 2026-09-24).
// John's decisions: the Export button is on each book's Detail page and on
// All Highlights, plus a command; "Save file…" uses the computer's own save
// window, so the file lands OUTSIDE the vault (Copy puts the same text on
// the clipboard); Markdown and plain text only; free. Every highlight that
// isn't dismissed is included. Nothing in the vault is written.
// ---------------------------------------------------------------------------

// The body of one "## Heading" section of a note, up to the next "## "
// heading (a "###" subheading stays inside), trimmed. '' when absent.
function markdownSection(content, heading) {
  const text = String(content || '');
  const sec = findNoteSection(text, heading);
  if (!sec) return '';
  return text.slice(sec.bodyStart, sec.end).replace(/%%[\s\S]*?%%/g, '').trim();
}

// Where a highlight sits in its book, so an export reads in book order:
// EPUB by chapter then page, PDF by page. Unknown places sort last.
function highlightBookOrder(h) {
  if (h.format === 'pdf') return [Number(h.location_page) || 1e9, 0];
  const m = /^spine:(\d+)(?::page:(\d+))?/.exec(String(h.location_cfi || ''));
  return m ? [Number(m[1]), Number(m[2] || 0)] : [1e9, 0];
}

// Just enough Markdown undone for a plain-text file: headings, bold/italic
// markers, wikilink brackets and block quotes.
function markdownToPlain(text) {
  return String(text || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')
    .replace(/^>\s?/gm, '');
}

// books: [{ title, author, notes, answers, highlights: [{ text, where, note, topic }] }]
// include: { notes, where, topic, bookNotes, answers }; fmt 'md' | 'txt'.
function buildHighlightsExport({ books, allBooks, fmt, include, dateText }) {
  const md = fmt === 'md';
  const out = [];
  const exported = `Exported from Reading Vault on ${dateText}`;
  const sub = allBooks ? '### ' : '## ';
  if (allBooks) out.push(md ? '# My highlights' : 'MY HIGHLIGHTS', exported, '');
  books.forEach((b, i) => {
    if (i > 0) out.push('', md ? '---' : '========================================', '');
    out.push(md ? `${allBooks ? '## ' : '# '}${b.title}` : b.title.toUpperCase());
    if (b.author) out.push(md ? `*${b.author}*` : b.author);
    if (!allBooks) out.push('', exported);
    out.push('');
    if (include.bookNotes && b.notes) out.push(md ? `${sub}My notes` : 'MY NOTES', '', md ? b.notes : markdownToPlain(b.notes), '');
    out.push(md ? `${sub}Highlights` : 'HIGHLIGHTS', '');
    for (const h of b.highlights) {
      const text = String(h.text || '').replace(/\s+/g, ' ').trim();
      out.push(md ? `> ${text}` : `"${text}"`);
      const meta = [];
      if (include.where && h.where) meta.push(h.where);
      if (include.topic && h.topic) meta.push(md ? `Topic: [[${h.topic}]]` : `Topic: ${h.topic}`);
      if (meta.length) out.push(md ? `> *${meta.join(' · ')}*` : `  (${meta.join(' · ')})`);
      if (include.notes && h.note) {
        const note = String(h.note).trim();
        out.push('', md ? `**My note:** ${note}` : `  My note: ${note.replace(/\n/g, '\n  ')}`);
      }
      out.push('');
    }
    if (include.answers && b.answers) out.push(md ? `${sub}Questions` : 'QUESTIONS', '', md ? b.answers : markdownToPlain(b.answers), '');
  });
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function exportFileName({ allBooks, title, dateKey, fmt }) {
  const base = allBooks ? 'My highlights' : `${sanitizeFilename(title || 'Book')} highlights`;
  return `${base} ${dateKey}.${fmt === 'txt' ? 'txt' : 'md'}`;
}

// ---------------------------------------------------------------------------
// Shelves (v0.12.0, free) -- named groups of books in the Library, built to
// the approved mockup-shelves.html (John, 2026-09-24). John's decisions:
// shelves are their own thing, separate from tags, kept as a `shelves` list
// on each book note (GL-002 to be updated in the vault); books on a shelf
// can be dragged into order; one level only (no shelf inside a shelf); they
// live in the Library grid's left column, plus a Shelves row in each book's
// Details box to add or remove the book.
//
// Where things live: which shelves a book is on = its own `shelves`
// frontmatter (readable, editable by hand). The shelf list itself and each
// shelf's book order = plugin settings (`settings.shelves`, [{ name, order:
// [book paths] }]), because an empty shelf and an order have no book note
// to live on. A shelf name typed straight into a book note still shows up.
// ---------------------------------------------------------------------------
const SHELF_NAME_MAX = 60;

function cleanShelfName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, SHELF_NAME_MAX);
}

// A book note's `shelves` value as a clean list: tolerates a single string
// or a hand-edited list with blanks and repeats.
function normShelfList(v) {
  const list = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  const out = [];
  for (const x of list) {
    const n = cleanShelfName(x);
    if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}

// Books on a shelf in its saved order; anything not in the order yet (just
// added, or added by hand in the note) goes after, by title.
function sortByShelfOrder(books, order) {
  const pos = new Map((order || []).map((p, i) => [p, i]));
  return books.slice().sort((a, b) => {
    const pa = pos.has(a.file.path) ? pos.get(a.file.path) : Infinity;
    const pb = pos.has(b.file.path) ? pos.get(b.file.path) : Infinity;
    if (pa !== pb) return pa - pb;
    return String(a.title || a.file.basename).localeCompare(String(b.title || b.file.basename));
  });
}

// The shelf's order after dropping `dragged` just before (or after) `target`.
function moveInOrder(paths, dragged, target, after) {
  if (dragged === target) return paths.slice();
  const out = paths.filter((p) => p !== dragged);
  const i = out.indexOf(target);
  if (i === -1) return [...out, dragged];
  out.splice(after ? i + 1 : i, 0, dragged);
  return out;
}

// ---------------------------------------------------------------------------
// Word lookup (v0.13.0) -- built to the approved mockup-word-lookup.html
// (John, 2026-09-24). John's decisions: Look up joins the selection pop-up
// for a single word; dictionaries are downloaded on demand from Settings →
// Word lookup, by language (English from Princeton WordNet; Spanish, French
// and German from Wiktionary, to follow); until one is downloaded the
// pop-up offers "Download dictionary", which opens Settings; Look up and
// Save word are free; "Explain in this sentence" is Pro, has its own switch
// and uses Ask's service and key; on a Mac the card links to Apple's
// Dictionary; saved words are one note each in Reading/Words.
//
// A dictionary is one sorted text file, "word<TAB>[[part of speech,
// meaning, example?], ...]" per line, built by the public
// a4-reading-dictionaries repository. It is kept OUTSIDE the vault (like
// Kokoro), in the computer's own app-data folder, so it never syncs.
// Downloading one is the plugin's third explicit network exception.
// ---------------------------------------------------------------------------
const DICT_BASE_URL = 'https://raw.githubusercontent.com/B0xfan/a4-reading-dictionaries/main/';
// The languages offered in Settings. `approx` is only the label shown
// before anything downloads; the real size comes from the repository's
// manifest.json when Download is pressed. Only languages whose file is
// really in the repository are listed (John left it to us, 2026-09-24):
// Spanish, French and German (each explained in its own language, John's
// choice) join this list in the same change that publishes their files.
const DICT_LANGUAGES = [
  { code: 'en', name: 'English', approx: 'about 6 MB' },
];

// Where downloaded dictionaries live: the computer's own app-data folder,
// never the vault. `platform` is Obsidian's Platform object.
function dictionaryDir(platform) {
  const pathMod = require('path');
  const home = require('os').homedir();
  if (platform && platform.isMacOS) return pathMod.join(home, 'Library', 'Application Support', 'a4-reading-dictionaries');
  if (platform && platform.isWin) return pathMod.join(process.env.APPDATA || pathMod.join(home, 'AppData', 'Roaming'), 'a4-reading-dictionaries');
  return pathMod.join(process.env.XDG_DATA_HOME || pathMod.join(home, '.local', 'share'), 'a4-reading-dictionaries');
}

// A selection counts as one word for Look up: letters (any language), with
// inner apostrophes or hyphens, up to 40 characters.
function lookupWordFrom(text) {
  const t = String(text || '').trim().replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, '');
  if (!t || t.length > 40) return null;
  return /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(t) ? t : null;
}

// The book's own language for an EPUB ("en-GB" -> "en"); null when unknown.
function epubLanguage(zipBuf) {
  try {
    const opf = locateOpf(zipBuf);
    const lang = opf ? extractFirstElement(opf.opfXml, 'language') : null;
    return lang ? normLangCode(lang) : null;
  } catch { return null; }
}

// A book's language label as a plain two-letter code, or null (QA fix
// v0.17.3). Three-letter codes ("eng") become two-letter ones; "und"
// (unknown, written by Calibre) or anything that isn't just letters gives
// null, so Look up falls back to the language in Settings. Only letters
// can come out, so the code is always safe to use in a file name.
// Dictionary files are named by language code: only plain letters are
// allowed into a file path (QA fix v0.17.3).
function isDictLang(lang) { return /^[a-z]{2,3}$/.test(String(lang || '')); }
const LANG_3_TO_2 = { eng: 'en', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', nld: 'nl', dut: 'nl', rus: 'ru', jpn: 'ja', zho: 'zh', chi: 'zh', kor: 'ko', ara: 'ar', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', pol: 'pl', tur: 'tr', ell: 'el', gre: 'el', heb: 'he', hin: 'hi', lat: 'la' };
function normLangCode(raw) {
  const code = String(raw || '').trim().toLowerCase().split(/[-_\s]/)[0];
  if (!/^[a-z]{2,3}$/.test(code) || code === 'und' || code === 'mul' || code === 'zxx') return null;
  if (code.length === 3) return LANG_3_TO_2[code] || null;
  return code;
}

// Binary search in a dictionary file's text (sorted by JavaScript string
// order, the same order the build script sorts by). Returns the parsed
// senses for `key`, or null.
function dictFind(text, key) {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const start = text.lastIndexOf('\n', mid - 1) + 1;
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const tab = text.indexOf('\t', start);
    const word = text.slice(start, tab === -1 || tab > end ? end : tab);
    if (word === key) {
      try { return JSON.parse(text.slice(tab + 1, end)); } catch { return null; }
    }
    if (word < key) lo = end + 1; else hi = start;
  }
  return null;
}

// English base forms to try, most likely first, each with the part of
// speech its ending suggests: "frittered" -> fritter (verb), "studies" ->
// study, "running" -> run (verb), "happiest" -> happy (adjective),
// "thumb-nail" -> thumbnail. WordNet's own ending rules plus doubled
// consonants; irregular forms ("went") come from the file's own pointers.
function englishForms(word) {
  const w = String(word).toLowerCase().replace(/[’']s$/, '').replace(/[’']$/, '');
  const out = [];
  const add = (key, prefer) => { if (key && key.length > 1 && !out.some((o) => o.key === key)) out.push({ key, prefer: prefer || null }); };
  add(w);
  if (w.includes('-')) { add(w.replace(/-/g, '')); add(w.replace(/-/g, ' ')); }
  const rules = [['ies', 'y', null], ['ied', 'y', 'verb'], ['ses', 's', null], ['xes', 'x', null], ['zes', 'z', null], ['ches', 'ch', null], ['shes', 'sh', null], ['men', 'man', 'noun'],
    ['es', 'e', null], ['es', '', null], ['s', '', null], ['ed', 'e', 'verb'], ['ed', '', 'verb'], ['ing', 'e', 'verb'], ['ing', '', 'verb'],
    ['iest', 'y', 'adjective'], ['ier', 'y', 'adjective'], ['est', '', 'adjective'], ['er', '', 'adjective'], ['est', 'e', 'adjective'], ['er', 'e', 'adjective'], ['ly', '', 'adverb']];
  for (const [end, rep, prefer] of rules) {
    if (!w.endsWith(end) || w.length <= end.length + 1) continue;
    const stem = w.slice(0, -end.length) + rep;
    add(stem, prefer);
    if (!rep && /([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1), prefer); // running -> runn -> run
  }
  return out;
}

// One looked-up word from a dictionary file's text: { base, senses } with
// senses as [part of speech, meaning, example?], the part of speech the
// word's ending suggests first. null when nothing matches.
function resolveLookup(text, word, lang) {
  const forms = lang === 'en'
    ? englishForms(word)
    : [...new Set([word, word.toLowerCase(), word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()])].map((key) => ({ key, prefer: null }));
  for (const f of forms) {
    const entry = dictFind(text, f.key);
    if (!entry || !entry.length) continue;
    let base = f.key;
    let prefer = f.prefer;
    let senses = entry.filter((x) => x[0] !== '=');
    for (const ptr of entry.filter((x) => x[0] === '=')) {
      const target = dictFind(text, ptr[1]) || [];
      const fromTarget = target.filter((x) => x[0] === ptr[2]);
      if (fromTarget.length) {
        if (!senses.length) { base = ptr[1]; prefer = ptr[2]; }
        senses = senses.concat(fromTarget.filter((x) => !senses.some((y) => y[1] === x[1])));
      }
    }
    if (!senses.length) continue;
    // "running" has its own noun entry, but in a sentence it's nearly always
    // the verb "run": bring in the base verb's meanings too, first.
    if (lang === 'en' && f.key === forms[0].key && /(ing|ed)$/.test(f.key)) {
      for (const g of forms.slice(1).filter((x) => x.prefer === 'verb')) {
        const verbs = (dictFind(text, g.key) || []).filter((x) => x[0] === 'verb');
        if (!verbs.length) continue;
        // ...unless it's also an adjective in its own right ("interesting"):
        // then its own meanings stay first and the verb follows.
        if (senses.some((x) => x[0] === 'adjective')) {
          senses = senses.filter((x) => x[0] === 'adjective').concat(verbs, senses.filter((x) => x[0] !== 'adjective'));
          prefer = null;
        } else { senses = verbs.concat(senses); base = g.key; prefer = 'verb'; }
        break;
      }
    }
    if (prefer) senses = senses.filter((x) => x[0] === prefer).concat(senses.filter((x) => x[0] !== prefer));
    return { base, senses: senses.slice(0, 6) };
  }
  return null;
}

function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDayKey(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(k || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
// Calendar-day arithmetic in local time (setDate, not +24h, so a DST
// change can never skip or double a day).
function addLocalDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d) { return addLocalDays(d, -((d.getDay() + 6) % 7)); }
function fmtMonthDay(d) { return `${DASH_MONTHS[d.getMonth()]} ${d.getDate()}`; }
function fmtClock(d) {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function fmtHour(h) { return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`; }
function fmtReminderTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return '8:00 PM';
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  return fmtClock(d);
}
// "About 14 min" / "About 2 hours" / "About 11 hours" -- mockup wording.
function fmtTimeLeft(min) {
  const m = Math.max(1, Math.round(min));
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return `${h} hours`;
}
function fmtPace(minPerPage) {
  const sec = minPerPage * 60;
  if (sec < 120) return { value: String(Math.round(sec)), unit: 'sec/page', words: `${Math.round(sec)} sec a page` };
  const mins = Math.round(minPerPage * 10) / 10;
  return { value: String(mins), unit: 'min/page', words: `${mins} min a page` };
}

// computeReadingPaceFrom -- the single pace rule shared by the Reader's
// progress strip and the dashboard: 'read'-mode sessions that turned real
// pages, flip-through sessions excluded. bookPath null = every book.
// minPerPage is null until there are READ_PACE_MIN_PAGES real pages.
function computeReadingPaceFrom(sessions, bookPath) {
  let minutes = 0;
  let pages = 0;
  if (Array.isArray(sessions)) {
    for (const s of sessions) {
      if (!s || s.mode !== 'read' || !s.book || !(s.pages > 0) || s.implausiblePace) continue;
      if (bookPath != null && s.book.path !== bookPath) continue;
      minutes += Number(s.activeMinutes) || 0;
      pages += s.pages;
    }
  }
  const minPerPage = pages >= READ_PACE_MIN_PAGES && minutes > 0 ? minutes / pages : null;
  return { minutes, pages, minPerPage };
}

// summarizeSessions -- one pass over every session ever recorded, grouped
// by LOCAL day. Nothing is dropped: the dashboard's calendar, streaks and
// yearly figures depend on the full history.
function summarizeSessions(sessions) {
  const days = new Map();
  const bookLast = new Map(); // book path -> Date of latest activity
  const bookFirst = new Map(); // book path -> Date of first recorded session
  let first = null;
  let longest = null;
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !s.start) continue;
    const st = new Date(s.start);
    if (Number.isNaN(st.getTime())) continue;
    const en = s.end ? new Date(s.end) : st;
    const key = localDayKey(st);
    let d = days.get(key);
    if (!d) {
      d = { read: 0, listen: 0, pages: 0, skipped: 0, sessions: 0, firstStart: null, lastEnd: null, books: new Map(), hours: new Map() };
      days.set(key, d);
    }
    const m = Math.max(0, Number(s.activeMinutes) || 0);
    const listen = s.mode === 'listen';
    if (listen) d.listen += m; else d.read += m;
    if (!listen) { if (s.implausiblePace) d.skipped += s.pages || 0; else d.pages += s.pages || 0; }
    d.sessions += 1;
    if (!d.firstStart || st < d.firstStart) d.firstStart = st;
    const endAt = Number.isNaN(en.getTime()) ? st : en;
    if (!d.lastEnd || endAt > d.lastEnd) d.lastEnd = endAt;
    const path = s.book && s.book.path;
    if (path) {
      d.books.set(path, (d.books.get(path) || 0) + m);
      const prev = bookLast.get(path);
      if (!prev || endAt > prev) bookLast.set(path, endAt);
      const firstForBook = bookFirst.get(path);
      if (!firstForBook || st < firstForBook) bookFirst.set(path, st);
    }
    const hr = st.getHours();
    const h = d.hours.get(hr) || { read: 0, listen: 0 };
    if (listen) h.listen += m; else h.read += m;
    d.hours.set(hr, h);
    if (!first || st < first) first = st;
    if (m > 0 && (!longest || m > longest.minutes)) longest = { minutes: m, mode: s.mode };
  }
  return { days, bookLast, bookFirst, first, longest };
}

// computeStreaks -- a day counts when its goal minutes (listening included
// or not, per the setting) are above zero. The current streak stays alive
// through today until today is over: read yesterday but not yet today
// still shows yesterday's run.
function computeStreaks(days, today, goalMin) {
  const has = (dt) => { const e = days.get(localDayKey(dt)); return !!e && goalMin(e) > 0; };
  const todayHas = has(today);
  let cur = 0;
  let d = todayHas ? today : addLocalDays(today, -1);
  while (has(d)) { cur += 1; d = addLocalDays(d, -1); }
  const keys = [...days.keys()].filter((k) => goalMin(days.get(k)) > 0).sort();
  let best = 0; let run = 0; let prevKey = null;
  for (const k of keys) {
    run = prevKey && localDayKey(addLocalDays(parseDayKey(prevKey), 1)) === k ? run + 1 : 1;
    if (run > best) best = run;
    prevKey = k;
  }
  return { cur, best, todayHas };
}

// estimateEpubPagesLeft -- the Reader's own "left in book" math
// (computeProgressStripData), run from the book's saved last_cfi
// ("spine:<idx>:page:<page>:of:<total>") instead of a live reader: the
// saved chapter's real bytes-per-page is the density, the byte-weighted
// percent is where the reader is. null when the saved position can't be
// read (e.g. a book carried over from A3 with a percent only).
function estimateEpubPagesLeft(spineInfo, lastCfi) {
  const m = /^spine:(\d+):page:(\d+):of:(\d+)$/.exec(String(lastCfi || ''));
  if (!m || !spineInfo || !Array.isArray(spineInfo.spine) || !spineInfo.spine.length) return null;
  const idx = Number(m[1]); const page = Number(m[2]); const total = Math.max(1, Number(m[3]));
  const { spine, entries } = spineInfo;
  if (idx >= spine.length) return null;
  const sizes = spine.map((s) => entries.get(s.resolvedPath)?.uncompressedSize || 0);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const bytesPerPage = (sizes[idx] || 0) / total;
  const pagesLeftInChapter = Math.max(0, total - (page + 1));
  if (totalBytes > 0 && bytesPerPage > 0) {
    const pctNow = computeEpubProgressPercent(spine, entries, idx, total, page);
    return (totalBytes * (1 - pctNow / 100)) / bytesPerPage;
  }
  return pagesLeftInChapter + (spine.length - 1 - idx) * total;
}

function svgEl(tag, attrs, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs || {})) n.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(n);
  return n;
}
function svgText(parent, x, y, s, extra) {
  const t = svgEl('text', Object.assign({ x, y, 'font-size': 10, fill: 'var(--a4r-ink-dim)' }, extra || {}), parent);
  t.textContent = s;
  return t;
}
// Hatch pattern ids must be unique per document: two dashboards (or a
// re-render racing the old DOM) must never resolve url(#id) to the other.
let dashHatchSeq = 0;
function svgHatch(svg) {
  dashHatchSeq += 1;
  const id = `a4r-hatch-${dashHatchSeq}`;
  const defs = svgEl('defs', {}, svg);
  const p = svgEl('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  svgEl('rect', { width: 6, height: 6, fill: 'transparent' }, p);
  svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--a4r-hatch)', 'stroke-width': 3 }, p);
  return `url(#${id})`;
}
function niceMax(v) {
  for (const s of [10, 20, 30, 40, 60, 80, 100, 120]) if (v <= s) return s;
  return Math.ceil(v / 50) * 50;
}

class EditGoalsModal extends Modal {
  constructor(app, plugin, onDone) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
  }

  onOpen() {
    const st = this.plugin.settings;
    this.titleEl.setText('Reading goals');
    const save = () => this.plugin.saveSettings();
    const num = (setting, key, min, max) => setting.addText((t) => {
      t.inputEl.type = 'number';
      t.inputEl.min = String(min); t.inputEl.max = String(max);
      t.setValue(String(st[key]));
      t.onChange((v) => {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < min || n > max) return;
        st[key] = n; save();
      });
    });
    num(new Setting(this.contentEl).setName('Minutes a day').setDesc('Fills the ring at the top of the dashboard.'), 'goalDailyMinutes', 1, 600);
    num(new Setting(this.contentEl).setName('Minutes a week').setDesc('Monday to Sunday.'), 'goalWeeklyMinutes', 1, 5000);
    num(new Setting(this.contentEl).setName('Books a year').setDesc('Books you mark as finished this year.'), 'goalYearlyBooks', 1, 365);
    new Setting(this.contentEl).setName('Listening counts toward goals')
      .addToggle((t) => t.setValue(!!st.listeningCountsTowardGoals).onChange((v) => { st.listeningCountsTowardGoals = v; save(); }));
    new Setting(this.contentEl).setName('Evening reminder').setDesc('A gentle note if the daily goal is not met yet. Only while Obsidian is open.')
      .addToggle((t) => t.setValue(!!st.reminderEnabled).onChange((v) => { st.reminderEnabled = v; save(); }));
    new Setting(this.contentEl).setName('Reminder time')
      .addText((t) => {
        t.inputEl.type = 'time';
        t.setValue(st.reminderTime || '20:00');
        t.onChange((v) => { if (/^\d{2}:\d{2}$/.test(v)) { st.reminderTime = v; st.reminderLastShown = null; save(); } });
      });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Done').setCta().onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
    if (this.onDone) this.onDone();
  }
}

class ReadingDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = new ReadingStore(this.app, plugin);
    this.epubEstimates = new Map(); // book path -> { key, pagesLeft } (key = last_cfi + file size, so a move/re-read recomputes)
    this.epubLoading = new Set();
    this.lastWidth = 0;
  }

  getViewType() { return DASHBOARD_VIEW_TYPE; }
  getDisplayText() { return 'Reading Dashboard'; }
  getIcon() { return 'chart-column'; }

  async onOpen() {
    // Book notes changing (progress, Mark as finished) redraw the Books
    // section; one trailing timer coalesces a burst of saves.
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file.path.startsWith(`${READING_DIR}/`)) this.scheduleRender(400);
    }));
    this.registerEvent(this.app.workspace.on('css-change', () => this.scheduleRender(50)));
    // Charts are sized to the pane's real width (so 10px text is really
    // 10px) and redrawn when the pane is resized.
    const host = this.containerEl.children[1];
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        const w = host.clientWidth;
        if (Math.abs(w - this.lastWidth) > 8) this.scheduleRender(120);
      });
      this.resizeObserver.observe(host);
    }
    // The running session's minutes grow in memory between saves, and the
    // day rolls over at midnight: a quiet redraw each minute keeps both
    // current (skipped while the tab is hidden).
    this.registerInterval(window.setInterval(() => {
      if (this.containerEl.isShown && !this.containerEl.isShown()) return;
      this.render();
    }, 60000));
    this.render();
  }

  async onClose() {
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
    if (this._renderTimer) window.clearTimeout(this._renderTimer);
  }

  scheduleRender(ms) {
    if (this._renderTimer) window.clearTimeout(this._renderTimer);
    this._renderTimer = window.setTimeout(() => { this._renderTimer = null; this.render(); }, ms);
  }

  render() {
    const host = this.containerEl.children[1];
    const oldRoot = host.querySelector('.a4r-dash-root');
    const scrollTop = oldRoot ? oldRoot.scrollTop : 0;
    host.empty();
    this.lastWidth = host.clientWidth;
    const root = host.createDiv({ cls: 'a4r-root a4r-dash-root' });
    const dash = root.createDiv({ cls: 'a4r-dash' });
    if (!this.plugin.isPro()) {
      this.renderLocked(dash);
      return;
    }
    const now = new Date();
    const st = this.plugin.settings;
    const sum = this.plugin.readingSummary(now);
    const ctx = { now, today: addLocalDays(now, 0), st, sum };
    try {
      this.renderHead(dash, ctx);
      this.renderToday(dash, ctx);
      this.renderGoals(dash, ctx);
      this.renderReviewCard(dash, ctx);
      this.renderHabit(dash, ctx);
      this.renderCharts(dash, ctx);
      this.renderBooks(dash, ctx);
      const note = dash.createDiv({ cls: 'a4r-dash-pro-note' });
      note.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });
      note.createSpan({ text: 'The dashboard is part of Reading Vault Pro. Reading, listening, highlights and notes stay free.' });
    } catch (err) {
      console.error('Reading Vault: dashboard render failed', err);
      dash.createDiv({ cls: 'a4r-dash-empty', text: 'The dashboard could not be drawn. Details are in the developer console.' });
    }
    root.scrollTop = scrollTop;
  }

  renderLocked(dash) {
    const head = dash.createDiv({ cls: 'a4r-dash-head' });
    const t = head.createDiv({ cls: 'a4r-dash-title' });
    t.createEl('h2', { text: 'Reading Dashboard' });
    t.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });
    dash.createDiv({ cls: 'a4r-dash-empty', text: 'Charts, goals and your reading calendar are in Pro.' });
  }

  section(dash, label, first) {
    return dash.createDiv({ cls: `a4r-dash-label${first ? ' a4r-dash-label-first' : ''}`, text: label });
  }

  card(parent, extraCls) {
    return parent.createDiv({ cls: `a4r-dash-card${extraCls ? ` ${extraCls}` : ''}` });
  }

  cardHead(card, title, flag) {
    const h = card.createEl('h3', { text: title });
    if (flag) h.createSpan({ cls: 'a4r-dash-goal-flag', text: flag });
    return h;
  }

  ring(parent, frac, big, small, stroke, cls) {
    const box = parent.createDiv({ cls: `a4r-dash-ring${cls ? ` ${cls}` : ''}` });
    const svg = svgEl('svg', { viewBox: '0 0 120 120' }, box);
    const r = 50; const c = 2 * Math.PI * r;
    svgEl('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: 'var(--a4r-line)', 'stroke-width': stroke }, svg);
    if (frac > 0) {
      svgEl('circle', {
        cx: 60, cy: 60, r, fill: 'none', stroke: 'var(--a4r-accent)', 'stroke-width': stroke, 'stroke-linecap': 'round',
        'stroke-dasharray': `${c * Math.min(frac, 1)} ${c}`, transform: 'rotate(-90 60 60)',
      }, svg);
    }
    const ctr = box.createDiv({ cls: 'a4r-dash-ring-center' });
    ctr.createDiv({ cls: 'a4r-dash-big', text: big });
    ctr.createDiv({ cls: 'a4r-dash-small', text: small });
    return box;
  }

  stepper(parent, label, valueText, onMinus, onPlus) {
    const row = parent.createDiv({ cls: 'a4r-dash-stepper' });
    row.createSpan({ cls: 'a4r-dash-stepper-lbl', text: label });
    const ctrl = row.createSpan({ cls: 'a4r-dash-stepper-ctrl' });
    const minus = ctrl.createEl('button', { text: '−', attr: { 'aria-label': `Lower ${label.toLowerCase()}` } });
    ctrl.createSpan({ cls: 'a4r-dash-stepper-val', text: valueText });
    const plus = ctrl.createEl('button', { text: '+', attr: { 'aria-label': `Raise ${label.toLowerCase()}` } });
    minus.onclick = onMinus;
    plus.onclick = onPlus;
    return row;
  }

  toggleRow(parent, label, on, onChange) {
    const row = parent.createDiv({ cls: 'a4r-dash-toggle-row' });
    row.createSpan({ text: label });
    const t = row.createEl('button', { cls: `a4r-dash-toggle${on ? ' is-on' : ''}`, attr: { role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label } });
    t.onclick = () => onChange(!on);
    return row;
  }

  async saveAndRender() {
    await this.plugin.saveSettings();
    this.plugin.refreshDashboards();
  }

  // ---------------- head + today ----------------
  renderHead(dash, { now }) {
    const head = dash.createDiv({ cls: 'a4r-dash-head' });
    const left = head.createDiv();
    const t = left.createDiv({ cls: 'a4r-dash-title' });
    t.createEl('h2', { text: 'Reading Dashboard' });
    t.createSpan({ cls: 'a4r-dash-pro', text: 'Pro' });
    left.createDiv({ cls: 'a4r-dash-date', text: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) });
    const edit = head.createEl('button', { cls: 'a4r-dash-btn', text: 'Edit goals' });
    setTooltip(edit, 'Change your goals');
    edit.onclick = () => new EditGoalsModal(this.app, this.plugin, () => this.plugin.refreshDashboards()).open();
  }

  renderToday(dash, { st, sum }) {
    this.section(dash, 'Today', true);
    const grid = dash.createDiv({ cls: 'a4r-dash-grid a4r-dash-g-today' });
    const goal = st.goalDailyMinutes;
    const gm = sum.todayGoalMinutes;
    const ringCard = this.card(grid, 'a4r-dash-ring-card');
    this.ring(ringCard, goal > 0 ? gm / goal : 0, String(Math.round(gm)), `of ${goal} min`, 11);
    const rt = ringCard.createDiv({ cls: 'a4r-dash-ring-text' });
    rt.createEl('h3', { text: 'Daily goal' });
    rt.createEl('p', {
      cls: 'a4r-dash-sub a4r-dash-sub-tight',
      text: `${Math.round(gm)} of ${goal} minutes, ${st.listeningCountsTowardGoals ? 'reading and listening both count' : 'reading only, listening not counted'}.`,
    });
    if (gm >= goal) rt.createSpan({ cls: 'a4r-dash-ok', text: 'Goal met today' });
    else rt.createSpan({ cls: 'a4r-dash-togo', text: `${Math.max(1, Math.round(goal - gm))} min to go` });

    const statsCard = this.card(grid);
    const stats = statsCard.createDiv({ cls: 'a4r-dash-stats' });
    const stat = (k, v, unit, n) => {
      const s = stats.createDiv({ cls: 'a4r-dash-stat' });
      s.createDiv({ cls: 'a4r-dash-k', text: k });
      const vEl = s.createDiv({ cls: 'a4r-dash-v', text: v });
      if (unit) vEl.createEl('small', { text: ` ${unit}` });
      s.createDiv({ cls: 'a4r-dash-n', text: n });
    };
    const d = sum.todayDay;
    const sessions = d ? d.sessions : 0;
    stat('Time today', String(Math.round(sum.todayMinutes)), 'min', sessions ? `${sessions} ${sessions === 1 ? 'session' : 'sessions'}` : 'Nothing recorded yet');
    stat('Pages read', String(sum.todayPages), '', d && d.skipped ? `${d.skipped} skimmed ${d.skipped === 1 ? 'page' : 'pages'} not counted` : 'Pages turned in the Reader');
    const cur = sum.streak.cur;
    let streakNote;
    if (sum.streak.todayHas) streakNote = `Read tomorrow to make it ${cur + 1}`;
    else if (cur > 0) streakNote = `Read today to make it ${cur + 1}`;
    else streakNote = 'Read today to start one';
    stat('Streak', String(cur), cur === 1 ? 'day' : 'days', streakNote);
    const pace = sum.pace;
    if (pace.minPerPage != null) {
      const p = fmtPace(pace.minPerPage);
      stat('Your pace', p.value, p.unit, `From ${Math.round(pace.minutes)} ${Math.round(pace.minutes) === 1 ? 'minute' : 'minutes'} of reading`);
    } else {
      stat('Your pace', '–', '', 'Shows after a few pages of reading');
    }
    const split = statsCard.createDiv({ cls: 'a4r-dash-split' });
    const bar = split.createDiv({ cls: 'a4r-dash-split-bar' });
    const read = d ? d.read : 0; const listen = d ? d.listen : 0; const tot = read + listen;
    if (tot > 0) {
      const a = bar.createSpan({ cls: 'a4r-dash-split-read' }); a.style.width = `${(read / tot) * 100}%`;
      const b = bar.createSpan({ cls: 'a4r-dash-split-listen' }); b.style.width = `${(listen / tot) * 100}%`;
    }
    const legend = split.createDiv({ cls: 'a4r-dash-split-legend' });
    const l1 = legend.createSpan(); l1.createEl('i', { cls: 'a4r-dash-dot a4r-dash-dot-read' }); l1.appendText(`Reading ${Math.round(read)} min`);
    const l2 = legend.createSpan(); l2.createEl('i', { cls: 'a4r-dash-dot a4r-dash-dot-listen' }); l2.appendText(`Listening ${Math.round(listen)} min`);
    if (d && d.firstStart && d.lastEnd) legend.createSpan({ text: `Between ${fmtClock(d.firstStart)} and ${fmtClock(d.lastEnd)}` });
  }

  // ---------------- goals ----------------
  renderGoals(dash, ctx) {
    const { st, sum, today } = ctx;
    this.section(dash, 'Goals');
    const grid = dash.createDiv({ cls: 'a4r-dash-grid a4r-dash-g-3' });

    // Books this year
    const year = today.getFullYear();
    const yc = this.card(grid);
    this.cardHead(yc, 'Books this year', 'your goal');
    yc.createEl('p', { cls: 'a4r-dash-sub', text: `Books you mark as finished in ${year}.` });
    const gr = yc.createDiv({ cls: 'a4r-dash-goal-ring' });
    const finished = sum.finishedThisYear;
    this.ring(gr, st.goalYearlyBooks > 0 ? finished.length / st.goalYearlyBooks : 0, String(finished.length), `of ${st.goalYearlyBooks}`, 12, 'a4r-dash-ring-sm');
    const yt = gr.createDiv({ cls: 'a4r-dash-year-text' });
    if (!finished.length) {
      yt.appendText('No books marked finished yet.');
      if (sum.closestBook) {
        yt.appendText(' ');
        yt.createEl('b', { text: sum.closestBook.title });
        yt.appendText(' is the closest.');
      }
    } else {
      const projected = projectBooksByYearEnd(finished.length, today);
      if (projected >= st.goalYearlyBooks) yt.appendText('On track: about ');
      else yt.appendText('At this rate, about ');
      yt.createEl('b', { text: `${projected} by December` });
      yt.appendText('.');
    }
    this.stepper(yc, 'Yearly goal', `${st.goalYearlyBooks} ${st.goalYearlyBooks === 1 ? 'book' : 'books'}`,
      () => { if (st.goalYearlyBooks > 1) { st.goalYearlyBooks -= 1; this.saveAndRender(); } },
      () => { if (st.goalYearlyBooks < 365) { st.goalYearlyBooks += 1; this.saveAndRender(); } });

    // This week
    const wc = this.card(grid);
    this.cardHead(wc, 'This week', 'your goal');
    wc.createEl('p', { cls: 'a4r-dash-sub', text: `Minutes ${st.listeningCountsTowardGoals ? 'read or listened' : 'read'}, Monday to Sunday.` });
    const week = wc.createDiv({ cls: 'a4r-dash-week' });
    const monday = mondayOf(today);
    const firstDay = sum.firstDay;
    let total = 0;
    const vals = [];
    for (let i = 0; i < 7; i += 1) {
      const d = addLocalDays(monday, i);
      const e = sum.days.get(localDayKey(d));
      vals.push({ d, m: e ? sum.goalMin(e) : 0 });
    }
    const maxM = Math.max(45, ...vals.map((v) => v.m));
    const todayKey = localDayKey(today);
    vals.forEach(({ d, m }, i) => {
      const k = localDayKey(d);
      const col = week.createDiv({ cls: 'a4r-dash-week-col' });
      const barEl = col.createDiv({ cls: 'a4r-dash-week-bar' });
      if (k > todayKey) { barEl.addClass('is-future'); barEl.setAttr('title', 'Still to come'); }
      else if (!firstDay || d < firstDay) { barEl.addClass('is-before'); barEl.setAttr('title', 'Before recording started'); }
      else if (!m) { barEl.addClass('is-none'); barEl.setAttr('title', '0 min'); }
      else { total += m; barEl.style.height = `${Math.max(8, Math.min(100, (m / maxM) * 100))}%`; barEl.setAttr('title', `${Math.round(m)} min`); }
      col.createDiv({ cls: `a4r-dash-week-d${k === todayKey ? ' is-today' : ''}`, text: DASH_WEEKDAYS[i] });
    });
    const meter = wc.createDiv({ cls: 'a4r-dash-meter' });
    const fill = meter.createSpan(); fill.style.width = `${Math.min(100, (total / Math.max(1, st.goalWeeklyMinutes)) * 100)}%`;
    const cap = wc.createDiv({ cls: 'a4r-dash-meter-cap' });
    const c1 = cap.createSpan();
    c1.createEl('b', { text: `${Math.round(total)} min` });
    c1.appendText(' so far');
    if (firstDay && firstDay > monday && localDayKey(firstDay) <= todayKey) c1.appendText(` (recording started ${firstDay.toLocaleDateString('en-US', { weekday: 'long' })})`);
    cap.createSpan({ text: `Goal ${st.goalWeeklyMinutes} min` });

    // Daily goal
    const dc = this.card(grid);
    this.cardHead(dc, 'Daily goal', 'your goal');
    dc.createEl('p', { cls: 'a4r-dash-sub', text: 'What fills the ring at the top.' });
    const s = this.stepper(dc, 'Minutes a day', `${st.goalDailyMinutes} min`,
      () => { if (st.goalDailyMinutes > 5) { st.goalDailyMinutes = Math.max(5, st.goalDailyMinutes - 5); this.saveAndRender(); } },
      () => { if (st.goalDailyMinutes < 600) { st.goalDailyMinutes = Math.min(600, st.goalDailyMinutes + 5); this.saveAndRender(); } });
    s.addClass('a4r-dash-stepper-top');
    this.toggleRow(dc, 'Listening counts toward goals', !!st.listeningCountsTowardGoals, (v) => { st.listeningCountsTowardGoals = v; this.saveAndRender(); });
    this.toggleRow(dc, `Gentle reminder at ${fmtReminderTime(st.reminderTime)} if not met`, !!st.reminderEnabled, (v) => { st.reminderEnabled = v; this.saveAndRender(); });
  }

  // ---------------- habit calendar ----------------
  // Highlight review (v0.9.0): one small card beside the goals, per the
  // approved mockup-highlight-review.html.
  renderReviewCard(dash, { now }) {
    const r = this.plugin.reviewSummary(now);
    this.section(dash, 'Highlight review');
    const card = this.card(dash, 'a4r-dash-review');
    card.createEl('h3', { text: 'Highlight review' });
    card.createDiv({ cls: 'a4r-dash-review-big', text: r.ready ? `${r.ready} ready` : 'All done' });
    const bits = [`${r.inReview} ${r.inReview === 1 ? 'highlight' : 'highlights'} in review`];
    if (r.lastReviewed) {
      const n = Math.round((addLocalDays(now, 0) - r.lastReviewed) / 86400000);
      bits.push(`last reviewed ${n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`}`);
    }
    card.createDiv({ cls: 'a4r-dash-sub', text: r.inReview ? bits.join(' · ') : 'Link a highlight to a Topic and it will start coming back here.' });
    if (r.ready) {
      const b = card.createEl('button', { cls: 'a4r-dash-btn a4r-dash-review-start', text: 'Start review' });
      b.onclick = () => this.plugin.openReview();
    }
  }

  renderHabit(dash, { sum, today, st }) {
    this.section(dash, 'Reading habit');
    const card = this.card(dash);
    const top = card.createDiv({ cls: 'a4r-dash-habit-top' });
    const pill = (k, v, unit) => {
      const p = top.createDiv({ cls: 'a4r-dash-pill' });
      p.createDiv({ cls: 'a4r-dash-k', text: k });
      const vEl = p.createDiv({ cls: 'a4r-dash-pill-v', text: v });
      vEl.createEl('small', { text: ` ${unit}` });
    };
    pill('Current streak', String(sum.streak.cur), sum.streak.cur === 1 ? 'day' : 'days');
    pill('Best streak', String(sum.streak.best), sum.streak.best === 1 ? 'day' : 'days');
    // "Days read, last 6 months" -- out of the days actually RECORDED in
    // that window, never counting days before recording began as misses.
    const windowStart = addLocalDays(today, -182);
    const firstDay = sum.firstDay;
    let daysRead = 0; let recorded = 0;
    for (let i = 182; i >= 0; i -= 1) {
      const d = addLocalDays(today, -i);
      if (!firstDay || d < firstDay) continue;
      recorded += 1;
      const e = sum.days.get(localDayKey(d));
      if (e && sum.goalMin(e) > 0) daysRead += 1;
    }
    pill('Days read, last 6 months', String(daysRead), recorded >= 183 || (firstDay && firstDay <= windowStart) ? 'of 183' : `of ${recorded} recorded`);

    const heat = card.createDiv({ cls: 'a4r-dash-heat' });
    const weeks = DASH_HEAT_WEEKS; const cell = 13; const gap = 3; const left = 26; const topPad = 16;
    const small = (this.lastWidth || 600) < 560;
    const fs = small ? 11 : 7.5;
    const svg = svgEl('svg', { viewBox: `0 0 ${left + weeks * (cell + gap)} ${topPad + 7 * (cell + gap)}`, role: 'img', 'aria-label': 'Reading calendar, last 26 weeks' }, heat);
    const hatch = svgHatch(svg);
    const lastMonday = mondayOf(today);
    const start = addLocalDays(lastMonday, -7 * (weeks - 1));
    ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((s, i) => { if (s) svgText(svg, 0, topPad + i * (cell + gap) + 10, small ? s[0] : s, { 'font-size': fs }); });
    const goal = Math.max(1, st.goalDailyMinutes);
    const level = (m) => (m < goal / 3 ? 1 : m < (goal * 2) / 3 ? 2 : m < (goal * 7) / 6 ? 3 : 4);
    const todayKey = localDayKey(today);
    let lastMonth = -1; let lastLabelW = -9;
    for (let w = 0; w < weeks; w += 1) {
      const wd = addLocalDays(start, w * 7);
      if (wd.getMonth() !== lastMonth) {
        lastMonth = wd.getMonth();
        if (w < weeks - 1 && w - lastLabelW >= 3) { svgText(svg, left + w * (cell + gap), 10, DASH_MONTHS[lastMonth], { 'font-size': fs }); lastLabelW = w; }
      }
      for (let r = 0; r < 7; r += 1) {
        const d = addLocalDays(wd, r);
        const k = localDayKey(d);
        if (k > todayKey) continue;
        const x = left + w * (cell + gap); const y = topPad + r * (cell + gap);
        const e = sum.days.get(k);
        const m = e ? sum.goalMin(e) : 0;
        const before = !firstDay || d < firstDay;
        let fill;
        if (before) fill = hatch;
        else if (!m) fill = 'var(--a4r-heat-0)';
        else fill = `var(--a4r-heat-${level(m)})`;
        const rc = svgEl('rect', { x, y, width: cell, height: cell, rx: 3, fill }, svg);
        if (k === todayKey) svgEl('rect', { x: x - 1.5, y: y - 1.5, width: cell + 3, height: cell + 3, rx: 4, fill: 'none', stroke: 'var(--a4r-ink)', 'stroke-width': 1.3 }, svg);
        const t = svgEl('title', {}, rc);
        t.textContent = `${d.toDateString()}${before ? ': before recording started' : `: ${Math.round(m)} min`}`;
      }
    }
    const legend = card.createDiv({ cls: 'a4r-dash-legend' });
    const scale = legend.createSpan({ cls: 'a4r-dash-scale' });
    scale.appendText('Less ');
    for (let i = 0; i <= 4; i += 1) scale.createEl('i', { cls: `a4r-dash-sw a4r-dash-heat-${i}` });
    scale.appendText(' More');
    const beforeKey = legend.createSpan({ cls: 'a4r-dash-scale' });
    beforeKey.createEl('i', { cls: 'a4r-dash-sw a4r-dash-sw-hatch' });
    beforeKey.appendText(' Before recording started');
  }

  // ---------------- last 30 days ----------------
  renderCharts(dash, ctx) {
    const { sum } = ctx;
    this.section(dash, `Last ${DASH_CHART_DAYS} days`);
    const grid = dash.createDiv({ cls: 'a4r-dash-grid a4r-dash-g-2' });
    const mc = this.card(grid, 'a4r-dash-chart');
    this.cardHead(mc, 'Minutes per day');
    const minSub = mc.createEl('p', { cls: 'a4r-dash-sub' });
    const minBox = mc.createDiv();
    const lg = mc.createDiv({ cls: 'a4r-dash-chart-legend' });
    const a = lg.createSpan(); a.createEl('i', { cls: 'a4r-dash-dot a4r-dash-dot-read' }); a.appendText('Reading');
    const b = lg.createSpan(); b.createEl('i', { cls: 'a4r-dash-dot a4r-dash-dot-listen' }); b.appendText('Listening');

    const tc = this.card(grid, 'a4r-dash-chart');
    this.cardHead(tc, 'When you read');
    const todSub = tc.createEl('p', { cls: 'a4r-dash-sub' });
    const todBox = tc.createDiv();
    const todFoot = tc.createDiv({ cls: 'a4r-dash-chart-foot' });

    const pgWrap = dash.createDiv({ cls: 'a4r-dash-grid a4r-dash-g-1' });
    const pc = this.card(pgWrap, 'a4r-dash-chart');
    this.cardHead(pc, 'Pages per day');
    const pgSub = pc.createEl('p', { cls: 'a4r-dash-sub' });
    const pgBox = pc.createDiv();

    // Real widths are only known once the cards are in the DOM (render()
    // builds into the live pane), so size each chart to its own box.
    this.renderDays(minBox, minSub, 'min', ctx);
    this.renderTimeOfDay(todBox, todSub, todFoot, ctx);
    this.renderDays(pgBox, pgSub, 'pages', ctx);
    void sum;
  }

  renderDays(box, subEl, kind, { sum, today, st }) {
    const W = Math.max(260, Math.round(box.clientWidth || 640));
    const H = W > 700 ? 150 : 170; const L = 30; const B = 22; const T = 8; const n = DASH_CHART_DAYS;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': kind === 'pages' ? 'Pages per day, last 30 days' : 'Minutes per day, last 30 days' }, box);
    const hatch = svgHatch(svg);
    const days = []; for (let i = n - 1; i >= 0; i -= 1) days.push(addLocalDays(today, -i));
    const vals = days.map((d) => sum.days.get(localDayKey(d)) || null);
    const v = (e) => (kind === 'pages' ? e.pages : e.read + e.listen);
    const peak = Math.max(10, ...vals.map((e) => (e ? v(e) : 0)), kind === 'min' ? st.goalDailyMinutes : 0);
    const vmax = niceMax(peak);
    const cw = (W - L) / n; const bw = cw * 0.64; const ph = H - B - T;
    const firstDay = sum.firstDay;
    let firstRec = days.findIndex((d) => firstDay && d >= firstDay);
    if (firstRec < 0) firstRec = n; // nothing recorded in the window at all
    if (firstRec > 0) {
      svgEl('rect', { x: L, y: T, width: firstRec * cw, height: ph, fill: hatch, opacity: 0.55, rx: 4 }, svg);
      const bandW = firstRec * cw;
      const label = firstDay ? `Before recording started (${fmtMonthDay(firstDay)})` : 'Nothing recorded yet';
      if (bandW > 150) {
        svgText(svg, L + bandW / 2, T + ph / 2 + 4, label, { 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 600 });
      }
    }
    for (let g = 0; g <= 2; g += 1) {
      const val = (vmax * g) / 2; const y = T + ph - (ph * g) / 2;
      svgEl('line', { x1: L, x2: W, y1: y, y2: y, stroke: 'var(--a4r-line)', 'stroke-width': 1, 'stroke-dasharray': g ? '3 4' : 'none' }, svg);
      svgText(svg, L - 6, y + 3.5, String(val), { 'text-anchor': 'end' });
    }
    days.forEach((d, i) => {
      const e = vals[i];
      const x = L + i * cw + (cw - bw) / 2;
      if (e) {
        if (kind === 'pages') {
          const h = (ph * e.pages) / vmax;
          if (h > 0) svgEl('rect', { x, y: T + ph - h, width: bw, height: h, rx: 2, fill: 'var(--a4r-accent)', opacity: 0.85 }, svg);
        } else {
          const hr = (ph * e.read) / vmax; const hl = (ph * e.listen) / vmax;
          if (hr > 0) svgEl('rect', { x, y: T + ph - hr, width: bw, height: hr, rx: 2, fill: 'var(--a4r-accent)' }, svg);
          if (hl > 0) svgEl('rect', { x, y: T + ph - hr - hl, width: bw, height: hl, rx: 2, fill: 'var(--a4r-listen)' }, svg);
        }
        const tt = svgEl('title', {}, svg);
        tt.textContent = `${fmtMonthDay(d)}: ${kind === 'pages' ? `${e.pages} pages` : `${Math.round(e.read + e.listen)} min`}`;
      }
      if (i % 7 === 1 || i === n - 1) {
        svgText(svg, L + i * cw + cw / 2, H - 6, i === n - 1 ? 'Today' : fmtMonthDay(d), { 'text-anchor': 'middle', fill: i === n - 1 ? 'var(--a4r-ink)' : 'var(--a4r-ink-dim)' });
      }
    });
    // Goal line drawn AFTER the bars so its label is never painted over.
    if (kind === 'min') {
      const y = T + ph - (ph * st.goalDailyMinutes) / vmax;
      svgEl('line', { x1: L, x2: W, y1: y, y2: y, stroke: 'var(--a4r-good)', 'stroke-width': 1.2, 'stroke-dasharray': '5 4' }, svg);
      svgText(svg, L + 4, y - 5, `goal ${st.goalDailyMinutes} min`, { 'text-anchor': 'start', fill: 'var(--a4r-good)', 'paint-order': 'stroke', stroke: 'var(--a4r-card)', 'stroke-width': 3, 'font-weight': 600 });
    }
    const active = vals.filter((e) => e && (kind === 'pages' ? e.pages > 0 : e.read + e.listen > 0));
    const tot = vals.reduce((acc, e) => acc + (e ? v(e) : 0), 0);
    if (kind === 'pages') {
      subEl.setText(active.length
        ? `${Math.round(tot)} ${Math.round(tot) === 1 ? 'page' : 'pages'} in ${DASH_CHART_DAYS} days, about ${Math.round(tot / active.length)} on days you read. Listening does not add pages; skimmed pages are left out.`
        : 'No pages read in the Reader yet. Listening does not add pages; skimmed pages are left out.');
    } else {
      const totR = Math.round(tot);
      const amount = totR >= 120 ? `${Math.round(totR / 6) / 10} hours` : `${totR} ${totR === 1 ? 'minute' : 'minutes'}`;
      subEl.setText(`${amount} in ${DASH_CHART_DAYS} days, ${active.length} ${active.length === 1 ? 'day' : 'days'} with reading. The dashed line is your daily goal.`);
    }
  }

  renderTimeOfDay(box, subEl, footEl, { sum, today }) {
    const hours = new Map();
    for (let i = DASH_CHART_DAYS - 1; i >= 0; i -= 1) {
      const e = sum.days.get(localDayKey(addLocalDays(today, -i)));
      if (!e) continue;
      for (const [h, v] of e.hours) {
        const cur = hours.get(h) || { read: 0, listen: 0 };
        cur.read += v.read; cur.listen += v.listen;
        hours.set(h, cur);
      }
    }
    const W = Math.max(260, Math.round(box.clientWidth || 360)); const H = 170; const L = 6; const B = 22; const T = 8;
    const ph = H - B - T; const cw = (W - L * 2) / 24; const bw = cw * 0.66;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Minutes by hour of the day, last 30 days' }, box);
    let vmax = 0; let peak = -1;
    for (let h = 0; h < 24; h += 1) { const e = hours.get(h); const m = e ? e.read + e.listen : 0; if (m > vmax) { vmax = m; peak = h; } }
    svgEl('rect', { x: L, y: T, width: cw * 6, height: ph, fill: 'var(--a4r-gray-soft)', opacity: 0.6, rx: 3 }, svg);
    svgEl('rect', { x: L + cw * 21, y: T, width: cw * 3, height: ph, fill: 'var(--a4r-gray-soft)', opacity: 0.6, rx: 3 }, svg);
    svgEl('line', { x1: L, x2: W - L, y1: T + ph, y2: T + ph, stroke: 'var(--a4r-line)' }, svg);
    for (let h = 0; h < 24; h += 1) {
      const e = hours.get(h);
      const x = L + h * cw + (cw - bw) / 2;
      if (e && vmax > 0 && e.read + e.listen > 0) {
        const hr = ((ph * e.read) / vmax) * 0.92; const hl = ((ph * e.listen) / vmax) * 0.92;
        if (hr > 0) svgEl('rect', { x, y: T + ph - hr, width: bw, height: hr, rx: 1.5, fill: 'var(--a4r-accent)' }, svg);
        if (hl > 0) svgEl('rect', { x, y: T + ph - hr - hl, width: bw, height: hl, rx: 1.5, fill: 'var(--a4r-listen)' }, svg);
        const tt = svgEl('title', {}, svg);
        tt.textContent = `${fmtHour(h)}: ${Math.round(e.read + e.listen)} min`;
      } else {
        svgEl('rect', { x, y: T + ph - 2, width: bw, height: 2, rx: 1, fill: 'var(--a4r-line)' }, svg);
      }
    }
    [[0, '12a'], [6, '6a'], [12, 'noon'], [18, '6p'], [23, '11p']].forEach(([h, s]) => svgText(svg, L + h * cw + cw / 2, H - 6, s, { 'text-anchor': 'middle' }));
    subEl.setText(`Last ${DASH_CHART_DAYS} days, by the hour you started.`);
    footEl.empty();
    if (peak < 0) { footEl.setText(`Nothing recorded in the last ${DASH_CHART_DAYS} days yet.`); return; }
    const recordedDays = sum.firstDay ? Math.min(DASH_CHART_DAYS, Math.floor((today - sum.firstDay) / 86400000) + 1) : 0;
    if (recordedDays < 7) {
      let part;
      if (peak >= 5 && peak < 12) part = 'morning';
      else if (peak >= 12 && peak < 15) part = 'early afternoon';
      else if (peak >= 15 && peak < 18) part = 'late afternoon';
      else if (peak >= 18 && peak < 22) part = 'evening';
      else part = 'night';
      footEl.appendText('Your reading so far is mostly in the ');
      footEl.createEl('b', { text: part });
      footEl.appendText('. The picture fills in over the next few weeks.');
    } else {
      footEl.appendText('You read most around ');
      footEl.createEl('b', { text: fmtHour(peak) });
      footEl.appendText('.');
    }
  }

  // ---------------- books ----------------
  renderBooks(dash, { sum, today, now }) {
    this.section(dash, 'Books');
    const grid = dash.createDiv({ cls: 'a4r-dash-grid a4r-dash-g-books' });
    const cc = this.card(grid);
    cc.createEl('h3', { text: 'Currently reading' });
    cc.createEl('p', { cls: 'a4r-dash-sub', text: 'Time left uses your own pace once a book has a few pages read.' });
    const books = sum.currentBooks;
    if (!books.length) cc.createDiv({ cls: 'a4r-dash-empty-line', text: 'Nothing in progress. Open a book from the Library to start.' });
    for (const b of books) this.renderBookRow(cc, b, sum, today, now);

    const fc = this.card(grid);
    this.cardHead(fc, `Finished in ${today.getFullYear()}`);
    const fin = sum.finishedThisYear;
    fc.createEl('p', {
      cls: 'a4r-dash-sub',
      text: fin.length ? `${fin.length} ${fin.length === 1 ? 'book' : 'books'} so far this year. Latest first.` : 'Books you mark as finished show up here with their covers.',
    });
    const shelf = fc.createDiv({ cls: 'a4r-dash-shelf' });
    if (!fin.length) {
      for (let i = 0; i < 4; i += 1) shelf.createDiv({ cls: 'a4r-dash-slot', text: i ? '' : 'none yet' });
    } else {
      const SHOW = 7;
      for (const b of fin.slice(0, SHOW)) {
        const f = shelf.createEl('figure');
        f.setAttr('title', `${b.title || b.file.basename} · finished ${fmtMonthDay(b.finishedOn)}`);
        this.coverInto(f, b, 'a4r-dash-shelf-cover');
        f.createEl('figcaption', { text: b.title || b.file.basename });
        f.onclick = () => this.plugin.openBookFromDashboard(b.file, 'detail');
      }
      if (fin.length > SHOW) shelf.createDiv({ cls: 'a4r-dash-slot', text: `+${fin.length - SHOW} more` });
    }
    const kv = fc.createDiv({ cls: 'a4r-dash-kv' });
    const row = (k, v) => { kv.createSpan({ text: k }); kv.createSpan({ text: v }); };
    row('Reading pace', sum.pace.minPerPage != null ? fmtPace(sum.pace.minPerPage).words : 'Not enough reading yet');
    if (sum.averageBookDays != null) row('Average book took', `${sum.averageBookDays} ${sum.averageBookDays === 1 ? 'day' : 'days'}`);
    if (sum.longest) row('Longest session', `${Math.round(sum.longest.minutes)} min${sum.longest.mode === 'listen' ? ' (listening)' : ''}`);
    row('Library', `${sum.libraryCount} ${sum.libraryCount === 1 ? 'book' : 'books'}, ${sum.inProgressCount} in progress`);
  }

  coverInto(parent, b, cls) {
    const coverFile = b.cover_path ? this.app.vault.getAbstractFileByPath(b.cover_path) : null;
    if (coverFile) {
      const img = parent.createEl('img', { cls, attr: { alt: '' } });
      img.src = this.app.vault.adapter.getResourcePath(b.cover_path);
      return img;
    }
    const [bg, fg] = pickPlaceholderColor(b.title || '');
    const ph = parent.createDiv({ cls: `${cls} a4r-dash-cover-ph`, text: b.title || '' });
    ph.style.background = bg; ph.style.color = fg;
    return ph;
  }

  renderBookRow(parent, b, sum, today, now) {
    const row = parent.createDiv({ cls: `a4r-dash-book${b.paused ? ' is-paused' : ''}` });
    this.coverInto(row, b, 'a4r-dash-cover');
    const body = row.createDiv({ cls: 'a4r-dash-book-body' });
    const title = body.createEl('button', { cls: 'a4r-dash-book-title', text: b.title || b.file.basename });
    setTooltip(title, 'Open in the Reader');
    title.onclick = () => this.plugin.openBookFromDashboard(b.file, 'reader');
    body.createDiv({ cls: 'a4r-dash-book-author', text: b.author || '' });
    const pct = typeof b.progress_percent === 'number' ? Math.max(0, Math.min(100, b.progress_percent)) : 0;
    const meter = body.createDiv({ cls: 'a4r-dash-meter' });
    const fill = meter.createSpan(); fill.style.width = `${pct}%`;
    const meta = body.createDiv({ cls: 'a4r-dash-book-meta' });
    const left = meta.createSpan();
    // PDFs show a real page ("Page 3 of 16"); page_count is often empty on
    // books carried over from A3, so it's worked back from the saved page
    // and percent when needed -- the Reader stores both.
    let pdfTotal = null;
    if (b.format === 'pdf') {
      pdfTotal = Number(b.page_count) > 0 ? Number(b.page_count)
        : (Number(b.last_page) > 0 && pct > 0 ? Math.round(Number(b.last_page) / (pct / 100)) : null);
    }
    if (b.format === 'pdf' && pdfTotal && Number(b.last_page) > 0) left.createEl('b', { text: `Page ${b.last_page} of ${pdfTotal}` });
    else { left.createEl('b', { text: `${pct < 1 && pct > 0 ? '<1' : Math.round(pct)}%` }); left.appendText(' read'); }
    const todayMin = sum.todayDay && sum.todayDay.books.get(b.file.path);
    if (todayMin && todayMin >= 0.5) left.appendText(` · ${Math.round(todayMin)} min today`);
    else if (b.paused && b.lastActive) left.appendText(` · paused since ${fmtMonthDay(b.lastActive)}`);
    else if (b.lastActive) left.appendText(` · last read ${fmtMonthDay(b.lastActive)}`);

    if (b.paused) {
      const pick = meta.createEl('button', { cls: 'a4r-dash-linkish', text: 'Pick it back up?' });
      pick.onclick = () => this.plugin.openBookFromDashboard(b.file, 'reader');
      return;
    }
    let pagesLeft = null;
    if (b.format === 'pdf') {
      if (pdfTotal && Number(b.last_page) > 0) pagesLeft = Math.max(0, pdfTotal - Number(b.last_page));
    } else if (b.format === 'epub') {
      pagesLeft = this.epubPagesLeft(b);
    }
    if (pagesLeft == null) return;
    const pace = computeReadingPaceFrom(this.plugin.sessionRecorder && this.plugin.sessionRecorder.sessions, b.file.path);
    const minPerPage = pace.minPerPage != null ? pace.minPerPage : FALLBACK_MIN_PER_PAGE;
    const minutes = pagesLeft * minPerPage;
    if (pace.minPerPage != null) {
      const r = meta.createSpan();
      r.appendText('About ');
      r.createEl('b', { text: fmtTimeLeft(minutes) });
      r.appendText(' left at your pace');
    } else {
      meta.createSpan({ cls: 'a4r-dash-est', text: `About ${fmtTimeLeft(minutes)} left (average pace, not enough reading yet)` });
    }
    void now; void today;
  }

  // EPUB "pages left" needs the book's chapter sizes -- read once per
  // saved position (a fresh read only when last_cfi changes), then the
  // dashboard redraws itself when the numbers are in.
  epubPagesLeft(b) {
    const path = b.file.path;
    const key = `${b.last_cfi || ''}|${b.file.stat ? b.file.stat.size : ''}`;
    const cached = this.epubEstimates.get(path);
    if (cached && cached.key === key) return cached.pagesLeft;
    if (!b.last_cfi || !b.file_path || this.epubLoading.has(path)) return cached ? cached.pagesLeft : null;
    this.epubLoading.add(path);
    (async () => {
      let pagesLeft = null;
      try {
        const ab = await this.app.vault.adapter.readBinary(b.file_path);
        const spineInfo = getEpubSpine(Buffer.from(ab));
        pagesLeft = estimateEpubPagesLeft(spineInfo, b.last_cfi);
      } catch (err) { console.error('Reading Vault: dashboard could not read', b.file_path, err); }
      this.epubEstimates.set(path, { key, pagesLeft });
      this.epubLoading.delete(path);
      if (pagesLeft != null) this.scheduleRender(30);
    })();
    return null;
  }
}

module.exports = class A4ReadingPlugin extends Plugin {
  async onload() {
    // obsidian://open-reading and obsidian://open-reading-highlight are
    // registered FIRST, before anything else in onload (settings load, view
    // registration, etc.) can throw and abort the rest of the method. A
    // protocol handler only ever takes effect for the lifetime of the
    // in-memory plugin instance that registered it -- Obsidian does not
    // re-run onload just because main.js changed on disk; it re-runs it
    // only when the plugin is actually reloaded (disable/enable, or an
    // app restart). If "Open in Reader" still errors
    // "Unrecognized URI action" after this fix ships, that in-memory-vs-disk
    // gap -- not a missing/misnamed registration -- is almost always why;
    // reload the plugin (or restart Obsidian) rather than re-editing this
    // code. See the Journal entry for how this was confirmed.
    this.registerReadingProtocolHandlers();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.resolveFolders(); // before anything reads or writes a book
    // Reading-session recording (2026-09-23 proof of concept) -- see
    // SessionRecorder for the on-disk format. Loaded early, before any
    // Reader view can log activity against it.
    this.sessionRecorder = new SessionRecorder(this);
    await this.sessionRecorder.load();
    this.registerInterval(window.setInterval(() => {
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      const view = leaf && leaf.view;
      const playing = !!(view && view.reader && view.reader.tts && view.reader.tts.playing);
      this.sessionRecorder.tick(playing);
    }, SESSION_TICK_MS));
    this.addCommand({
      id: 'reading-today',
      name: "Today's reading",
      callback: () => this.sessionRecorder.showToday(),
    });
    // Per-language voice choices (settings page, 2026-09-22). Carry over
    // the single saved Kokoro voice from before; a saved system voice (or
    // none) becomes Kokoro's best-graded voice.
    const st = this.settings;
    let changed = false;
    if (!st.ttsVoices || typeof st.ttsVoices !== 'object') { st.ttsVoices = {}; changed = true; }
    if (!st.ttsVoices.en) {
      const saved = typeof st.ttsVoiceURI === 'string' && st.ttsVoiceURI.startsWith('kokoro:') ? st.ttsVoiceURI : 'kokoro:af_heart';
      const ticked = KOKORO_VOICES.map((id) => `kokoro:${id}`);
      if (!ticked.includes(saved)) ticked.unshift(saved);
      st.ttsVoices.en = { ticked, default: saved };
      changed = true;
    }
    if ('ttsVoiceURI' in st) { delete st.ttsVoiceURI; changed = true; }
    st.shelves = Array.isArray(st.shelves) ? st.shelves.map((x) => ({ name: x && x.name, order: Array.isArray(x && x.order) ? x.order.slice() : [] })) : [];
    if (!st.ttsLanguage) { st.ttsLanguage = 'en'; changed = true; }
    if (changed) await this.saveSettings();
    this.addSettingTab(new ReadingSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new ReadingView(leaf, this));
    this.addRibbonIcon('book-open', 'Open Reading Vault', () => this.activateView());
    this.addCommand({ id: 'open-reading', name: 'Open library', callback: () => this.activateView() });

    // Reading Dashboard (v0.8.0): its own tab, from a ribbon button, a
    // command, or the Library's "Today" strip.
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new ReadingDashboardView(leaf, this));
    this.addRibbonIcon('chart-column', 'Open reading dashboard', () => this.activateDashboard());
    this.addCommand({ id: 'open-reading-dashboard', name: 'Open reading dashboard', callback: () => this.activateDashboard() });
    // Highlight review (v0.9.0): a command (so it can have a hotkey), the
    // Library's Today line and a Dashboard card all open it.
    this.addCommand({ id: 'review-highlights', name: 'Review highlights', callback: () => this.openReview() });
    // Full screen (v0.15.0): a command so it can have a hotkey. Offered
    // while a book is open in the Reader; pressed again, it exits.
    this.addCommand({
      id: 'open-full-screen', name: 'Open in full screen',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        const view = leaf && leaf.view;
        if (!view || view.screen !== 'reader' || !view.reader) return false;
        if (!checking) { if (view.fullScreen) view.exitFullScreen(); else view.enterFullScreen(); }
        return true;
      },
    });
    // Export highlights (v0.11.0): the book open in the Reading tab (Detail
    // or Reader) if there is one, otherwise all books.
    this.addCommand({
      id: 'export-highlights', name: 'Export highlights',
      callback: () => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        const view = leaf && leaf.view;
        const book = view && view.currentBook && (view.screen === 'detail' || view.screen === 'reader') ? view.currentBook : null;
        this.openExport(book);
      },
    });
    // Evening reminder (off by default): checked once a minute while
    // Obsidian is open; see checkReadingReminder().
    this.registerInterval(window.setInterval(() => this.checkReadingReminder(new Date()), 60000));

    // Rename gap fix: a book note's own path is the only thing linking its
    // highlights back to it (`book_path` on each book_highlight note) — a
    // rename/move must not orphan them. Vault-level (not view-level) so it
    // fires even with the Reading view closed.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.handleBookRename(file, oldPath).catch((err) => console.error('Reading Vault: book rename fix-up failed', err));
    }));

    // Highlights-in-book-note backfill: gentle, one-time, only for books
    // whose generated section would actually change. Waits for the initial
    // metadata-cache pass the same way ReadingView.onOpen() does, so
    // frontmatter reads aren't racing Obsidian's own startup indexing.
    const kickBackfill = () => {
      this.app.metadataCache.off('resolved', kickBackfill);
      this.runHighlightsBackfillIfNeeded().catch((err) => console.error('Reading Vault: highlights backfill failed', err));
    };
    this.app.metadataCache.on('resolved', kickBackfill);
    this.register(() => this.app.metadataCache.off('resolved', kickBackfill));
  }

  // obsidian://open-reading — lets "04 Inner World/My Life/Reading/Reading.md"
  // open the library, same pattern as a4-health/a4-finance's own
  // registerObsidianProtocolHandler('open-health' / 'open-finance', ...).
  //
  // obsidian://open-reading-highlight?hl=<vault path> — the "Open in
  // Reader" link the Highlights-in-book-note section writes for each
  // highlight. Opens/reveals the Reading view, then hands off to the
  // already-open view's own jump logic (openHighlightInReader) rather
  // than duplicating any reader/book-resolution logic here.
  //
  // Wrapped in try/catch and called first in onload() (see the comment
  // there) so neither handler's registration can ever be skipped by an
  // unrelated failure elsewhere in onload.
  registerReadingProtocolHandlers() {
    try {
      this.registerObsidianProtocolHandler('open-reading', () => {
        this.activateView();
      });
      this.registerObsidianProtocolHandler('open-reading-highlight', async (params) => {
        const hlPath = params.hl;
        if (!hlPath) return;
        await this.activateView();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        const view = leaf && leaf.view;
        if (view && typeof view.openHighlightInReader === 'function') view.openHighlightInReader(hlPath);
      });
    } catch (err) {
      console.error('Reading Vault: could not register obsidian:// protocol handlers', err);
    }
  }

  // ---------------- Folders (v0.18.0) ----------------
  // Built to the approved docs/mockups/mockup-folders.html (John,
  // 2026-09-25). Chosen once: a vault that already has the original A4
  // Reading folder keeps it (and the other original folders), so nothing
  // moves on update; anyone else starts with NEW_USER_FOLDERS. Saved, so
  // the choice never changes by itself later.
  async resolveFolders() {
    const st = this.settings;
    if (!cleanFolderPath(st.readingFolder) || !cleanFolderPath(st.topicsFolder) || !cleanFolderPath(st.filesFolder)) {
      let legacy = false;
      try { legacy = await this.app.vault.adapter.exists(LEGACY_FOLDERS.reading); } catch { legacy = false; }
      const base = legacy ? LEGACY_FOLDERS : NEW_USER_FOLDERS;
      st.readingFolder = cleanFolderPath(st.readingFolder) || base.reading;
      st.topicsFolder = cleanFolderPath(st.topicsFolder) || base.topics;
      st.filesFolder = cleanFolderPath(st.filesFolder) || base.files;
      await this.saveSettings();
    }
    applyFolders(this.folderSettings());
  }

  folderSettings() {
    const st = this.settings;
    return { reading: st.readingFolder, topics: st.topicsFolder, files: st.filesFolder };
  }

  // What Reading Vault keeps in one of its folders right now:
  // { files: [TFile], counts: [[n, 'book note', 'book notes'], ...] }.
  folderContents(kind) {
    const under = (dir) => this.app.vault.getFiles().filter((f) => f.path.startsWith(`${dir}/`));
    if (kind === 'reading') {
      const books = new ReadingStore(this.app, this).listBookFiles();
      const highlights = under(HIGHLIGHTS_DIR).filter((f) => f.extension === 'md');
      const words = under(WORDS_DIR).filter((f) => f.extension === 'md');
      const landing = this.app.vault.getAbstractFileByPath(LANDING_NOTE);
      return {
        files: [...books, ...highlights, ...words, ...(landing instanceof TFile ? [landing] : [])],
        counts: [[books.length, 'book note', 'book notes'], [highlights.length, 'highlight', 'highlights'], [words.length, 'saved word', 'saved words']],
      };
    }
    if (kind === 'topics') {
      const topics = under(TOPICS_DIR);
      return { files: topics, counts: [[topics.filter((f) => f.extension === 'md').length, 'Topic note', 'Topic notes']] };
    }
    const books = under(BOOKS_ASSET_DIR);
    const covers = under(COVERS_ASSET_DIR);
    return { files: [...books, ...covers], counts: [[books.length, 'book file', 'book files'], [covers.length, 'cover', 'covers']] };
  }

  // Points one folder setting somewhere else. With move: true, first moves
  // what Reading Vault already keeps there, keeping any subfolders, through
  // Obsidian's own rename (so every link to it is updated), then fixes the
  // paths Reading Vault itself stores: a highlight's or saved word's book_path
  // and topic_path, a book's file_path and cover_path, shelf order and the
  // reading history. Nothing is deleted; emptied folders stay. Returns how
  // many files moved.
  async changeFolder(kind, to, { move = false } = {}) {
    const key = { reading: 'readingFolder', topics: 'topicsFolder', files: 'filesFolder' }[kind];
    const from = this.settings[key];
    const moved = new Map(); // old path -> new path
    if (move) {
      const { files } = this.folderContents(kind);
      const roots = kind === 'files' ? [FILES_DIR] : kind === 'topics' ? [TOPICS_DIR] : [READING_DIR];
      this._movingFolders = true;
      try {
        for (const f of files) {
          const root = roots.find((r) => f.path.startsWith(`${r}/`));
          if (!root) continue;
          let target = `${to}/${f.path.slice(root.length + 1)}`;
          if (target === f.path) continue;
          const dir = target.slice(0, target.lastIndexOf('/'));
          const parts = dir.split('/');
          // eslint-disable-next-line no-await-in-loop -- one folder at a time
          for (let i = 1; i <= parts.length; i += 1) await ensureFolder(this.app, parts.slice(0, i).join('/'));
          if (this.app.vault.getAbstractFileByPath(target)) {
            const name = target.slice(dir.length + 1);
            const dot = name.lastIndexOf('.');
            // eslint-disable-next-line no-await-in-loop
            target = await uniqueVaultPath(this.app, dir, dot > 0 ? name.slice(0, dot) : name, dot > 0 ? name.slice(dot + 1) : '');
          }
          const old = f.path;
          // eslint-disable-next-line no-await-in-loop -- sequential on purpose: one rename at a time
          await this.app.fileManager.renameFile(f, target);
          moved.set(old, f.path);
        }
      } finally { this._movingFolders = false; }
    }
    this.settings[key] = to;
    applyFolders(this.folderSettings());
    await this.saveSettings();
    if (moved.size) await this.fixMovedPaths(moved);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => { if (leaf.view && leaf.view.softRefresh) leaf.view.softRefresh(); });
    return { from, to, moved: moved.size };
  }

  async fixMovedPaths(moved) {
    const fields = ['book_path', 'topic_path', 'file_path', 'cover_path'];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
      const listHit = fm && Array.isArray(fm.book_paths) && fm.book_paths.some((p) => moved.has(p));
      if (!fm || (!listHit && !fields.some((k) => typeof fm[k] === 'string' && moved.has(fm[k])))) continue;
      // eslint-disable-next-line no-await-in-loop -- one note at a time
      await this.app.fileManager.processFrontMatter(f, (w) => {
        for (const k of fields) if (typeof w[k] === 'string' && moved.has(w[k])) w[k] = moved.get(w[k]);
        if (Array.isArray(w.book_paths)) w.book_paths = w.book_paths.map((p) => moved.get(p) || p);
      });
    }
    const shelves = Array.isArray(this.settings.shelves) ? this.settings.shelves : [];
    if (shelves.some((sh) => (sh.order || []).some((p) => moved.has(p)))) {
      this.settings.shelves = shelves.map((sh) => ({ ...sh, order: (sh.order || []).map((p) => moved.get(p) || p) }));
      await this.saveSettings();
    }
    const rec = this.sessionRecorder;
    if (rec && rec.sessions.some((x) => x.book && moved.has(x.book.path))) {
      // In place, so a session still running keeps pointing at its record.
      for (const x of rec.sessions) if (x.book && moved.has(x.book.path)) x.book = { ...x.book, path: moved.get(x.book.path) };
      await rec.persist();
    }
  }

  // handleBookRename — only book notes matter (never a highlight note's own
  // path, which nothing else references by path). Updates every highlight
  // that pointed at the old path to the new one; sequential is fine here,
  // a rename affects at most one book's worth of highlights at a time.
  async handleBookRename(file, oldPath) {
    if (this._movingFolders) return; // a folder move fixes its own paths (see changeFolder)
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (!oldPath.startsWith(`${READING_DIR}/`) || oldPath.startsWith(`${HIGHLIGHTS_DIR}/`) || oldPath.startsWith(`${WORDS_DIR}/`)) return;
    if (oldPath === LANDING_NOTE) return;
    // Highlights and (QA fix v0.17.2) saved words both point at their book.
    const highlightFiles = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${HIGHLIGHTS_DIR}/`) || f.path.startsWith(`${WORDS_DIR}/`));
    const affected = highlightFiles.filter((f) => {
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      return fm.book_path === oldPath || (Array.isArray(fm.book_paths) && fm.book_paths.includes(oldPath));
    });
    for (const hf of affected) {
      // eslint-disable-next-line no-await-in-loop -- a single rename never
      // touches more than one book's highlights; no burst to worry about.
      await this.app.fileManager.processFrontMatter(hf, (fm) => {
        if (fm.book_path === oldPath) fm.book_path = file.path;
        // A saved word's list of books (v0.18.1).
        if (Array.isArray(fm.book_paths)) fm.book_paths = fm.book_paths.map((p) => (p === oldPath ? file.path : p));
      });
    }
    // Shelves (v0.12.0): a shelf's saved order refers to books by path.
    const shelves = Array.isArray(this.settings.shelves) ? this.settings.shelves : [];
    if (shelves.some((s) => (s.order || []).includes(oldPath))) {
      this.settings.shelves = shelves.map((s) => ({ ...s, order: (s.order || []).map((p) => (p === oldPath ? file.path : p)) }));
      await this.saveSettings();
    }
  }

  // runHighlightsBackfillIfNeeded — builds the Highlights section once for
  // every existing book that has one, sequentially (never Promise.all — a
  // burst of vault writes across a whole library is exactly what the brief
  // asked NOT to do), and only actually writes a book whose generated block
  // differs from what's already there. Gated by highlightsBackfillDone so
  // it only ever runs once, whether that's on first load (setting defaults
  // ON) or whenever the user later flips the setting on for the first time.
  async runHighlightsBackfillIfNeeded() {
    if (!this.settings.highlightsInBookNote) return;
    if (this.settings.highlightsBackfillDone) return;
    const store = new ReadingStore(this.app, this);
    const books = store.listBookFiles();
    let changedCount = 0;
    for (const bookFile of books) {
      // eslint-disable-next-line no-await-in-loop -- deliberately
      // sequential; see the comment above this method.
      const wrote = await store.syncHighlightsSection(bookFile);
      if (wrote) changedCount += 1;
    }
    this.settings.highlightsBackfillDone = true;
    await this.saveSettings();
    this.lastHighlightsBackfillCount = changedCount;
    console.info(`Reading Vault: highlights backfill touched ${changedCount} of ${books.length} book note(s).`);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // ---------------- Reading Dashboard (v0.8.0) ----------------

  async activateDashboard() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // ---------------- Export highlights (v0.11.0) ----------------

  // Opens the Export window; with a book it starts on "This book".
  openExport(bookFile) {
    new ExportHighlightsModal(this.app, this, bookFile || null).open();
  }

  // Every book with its highlights (not dismissed, in book order) and the
  // two book-note sections the export can include.
  async gatherExportBooks() {
    const store = new ReadingStore(this.app, this);
    const books = [];
    for (const b of store.listBooks()) {
      const hls = store.listHighlights(b.file.path)
        .filter((h) => h.status !== 'dismissed')
        .sort((x, y) => {
          const a = highlightBookOrder(x), c = highlightBookOrder(y);
          return a[0] - c[0] || a[1] - c[1] || String(x.highlighted_at || '').localeCompare(String(y.highlighted_at || ''));
        });
      let content = '';
      try { content = await this.app.vault.cachedRead(b.file); } catch { content = ''; }
      books.push({
        path: b.file.path,
        title: b.title || b.file.basename,
        author: b.author || '',
        notes: markdownSection(content, 'Notes'),
        answers: markdownSection(content, 'Questions'),
        highlights: hls.map((h) => ({
          text: h.excerpt || '',
          where: describeHighlightLocationForNote(h),
          note: h.note ? String(h.note) : '',
          topic: h.status === 'linked' && h.topic_path ? h.topic_path.split('/').pop().replace(/\.md$/, '') : '',
        })),
      });
    }
    return books.sort((a, b) => a.title.localeCompare(b.title));
  }

  // "Save file…" -- the computer's own save window (Mac or Windows), so the
  // file goes wherever the reader picks, outside the vault (John,
  // 2026-09-24). Returns the saved path, or null when cancelled. If
  // Obsidian doesn't expose the save window, falls back to a normal
  // download, which Obsidian also hands to the system.
  async saveFileOutsideVault(name, text, fmt) {
    let dialog = null;
    try {
      const electron = require('electron');
      const remote = electron.remote || (() => { try { return require('@electron/remote'); } catch { return null; } })();
      dialog = remote && remote.dialog;
    } catch { dialog = null; }
    const filters = fmt === 'txt' ? [{ name: 'Plain text', extensions: ['txt'] }] : [{ name: 'Markdown', extensions: ['md'] }];
    if (dialog && typeof dialog.showSaveDialog === 'function') {
      const pathMod = require('path');
      const res = await dialog.showSaveDialog({ title: 'Export highlights', defaultPath: pathMod.join(require('os').homedir(), name), filters });
      if (!res || res.canceled || !res.filePath) return null;
      require('fs').writeFileSync(res.filePath, text, 'utf8');
      return res.filePath;
    }
    const blob = new Blob([text], { type: fmt === 'txt' ? 'text/plain' : 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    return name;
  }

  // ---------------- Word lookup (v0.13.0) ----------------

  dictDir() { return dictionaryDir(Platform); }

  // { installed, bytes, source } for one language, from the folder on disk.
  dictStatus(lang) {
    if (!isDictLang(lang)) return { installed: false, bytes: 0, source: '', version: '' };
    const fs = require('fs');
    const pathMod = require('path');
    try {
      const meta = JSON.parse(fs.readFileSync(pathMod.join(this.dictDir(), `${lang}.json`), 'utf8'));
      const st = fs.statSync(pathMod.join(this.dictDir(), `${lang}.tsv`));
      return { installed: true, bytes: st.size, source: meta.source || '', version: meta.version || '' };
    } catch { return { installed: false, bytes: 0, source: '', version: '' }; }
  }

  // The language Look up should use for the open book: an EPUB's own
  // language when it says, otherwise the reading language in Settings.
  lookupLanguage(r) {
    if (r && r.format === 'epub' && r.epub && r.epub.buf) {
      if (r.lookupLang === undefined) r.lookupLang = epubLanguage(r.epub.buf);
      if (r.lookupLang) return r.lookupLang;
    }
    return normLangCode(this.settings.ttsLanguage || 'en') || 'en';
  }

  // The whole file's text, read once per session and kept for later lookups
  // (about 19 MB for English). Returns null when not downloaded.
  dictText(lang) {
    if (!isDictLang(lang)) return null;
    this._dictCache = this._dictCache || new Map();
    if (this._dictCache.has(lang)) return this._dictCache.get(lang);
    let text = null;
    try { text = require('fs').readFileSync(require('path').join(this.dictDir(), `${lang}.tsv`), 'utf8'); } catch { text = null; }
    if (text) this._dictCache.set(lang, text);
    return text;
  }

  // { base, senses } or null (not found), or undefined (no dictionary).
  dictLookup(lang, word) {
    const text = this.dictText(lang);
    if (!text) return undefined;
    return resolveLookup(text, word, lang);
  }

  // Downloads a file with progress when the browser allows it (onProgress
  // gets 0..1), falling back to Obsidian's requestUrl. Returns an ArrayBuffer.
  async dictFetch(url, onProgress) {
    if (typeof window.fetch === 'function' && typeof ReadableStream !== 'undefined') {
      try {
        const res = await window.fetch(url);
        if (!res.ok) { const e = new Error(`status ${res.status}`); e.status = res.status; throw e; }
        const total = Number(res.headers.get('content-length')) || 0;
        if (!res.body || !total) return await res.arrayBuffer();
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          if (onProgress) onProgress(Math.min(1, got / total));
        }
        const out = new Uint8Array(got);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        return out.buffer;
      } catch (err) {
        if (err && err.status) throw err;
        // A browser-side block (e.g. no CORS) -- try Obsidian's own request.
      }
    }
    const res = await requestUrl({ url, method: 'GET', throw: false });
    if (res.status >= 400) { const e = new Error(`status ${res.status}`); e.status = res.status; throw e; }
    return res.arrayBuffer;
  }

  // Settings → Download: the repository's manifest says which languages
  // exist, their file and checksum. The file is checked, unpacked and saved
  // outside the vault. Throws an Error with a plain message on failure.
  async dictInstall(lang, onProgress) {
    if (!isDictLang(lang)) throw new Error("That language isn't available.");
    let manifest;
    try {
      const buf = await this.dictFetch(`${DICT_BASE_URL}manifest.json`);
      manifest = JSON.parse(Buffer.from(buf).toString('utf8'));
    } catch (err) {
      console.error('Reading Vault: dictionary list could not be read', err);
      throw new Error("Couldn't reach the dictionary download. Check your internet connection and try again.");
    }
    const entry = (manifest.dictionaries || []).find((d) => d.lang === lang);
    const name = (DICT_LANGUAGES.find((l) => l.code === lang) || { name: lang }).name;
    if (!entry) throw new Error(`The ${name} dictionary isn't ready yet. It's coming in a later update.`);
    let gz;
    try {
      gz = Buffer.from(await this.dictFetch(`${DICT_BASE_URL}${entry.file}`, onProgress));
    } catch (err) {
      console.error('Reading Vault: dictionary download failed', err);
      throw new Error(`The ${name} dictionary didn't download. Check your internet connection and try again.`);
    }
    // The checksum is required, never optional (QA fix v0.17.3).
    if (!entry.sha256 || sha256Hex(gz) !== entry.sha256) throw new Error(`The ${name} dictionary arrived damaged. Please try again.`);
    let text;
    try { text = zlib.gunzipSync(gz); } catch { throw new Error(`The ${name} dictionary arrived damaged. Please try again.`); }
    const fs = require('fs');
    const pathMod = require('path');
    fs.mkdirSync(this.dictDir(), { recursive: true });
    const tsvPath = pathMod.join(this.dictDir(), `${lang}.tsv`);
    fs.writeFileSync(`${tsvPath}.part`, text);
    fs.renameSync(`${tsvPath}.part`, tsvPath);
    fs.writeFileSync(pathMod.join(this.dictDir(), `${lang}.json`), JSON.stringify({ lang, version: entry.version || '', source: entry.source || '', sha256: entry.sha256 || '' }));
    if (this._dictCache) this._dictCache.delete(lang);
    return this.dictStatus(lang);
  }

  dictRemove(lang) {
    if (!isDictLang(lang)) return;
    const fs = require('fs');
    const pathMod = require('path');
    for (const f of [`${lang}.tsv`, `${lang}.json`]) { try { fs.unlinkSync(pathMod.join(this.dictDir(), f)); } catch { /* already gone */ } }
    if (this._dictCache) this._dictCache.delete(lang);
  }

  // "Explain in this sentence" is shown when it can work: Pro, its own
  // switch on, and Ask ready (switched on with a key).
  lookupAiReady() {
    return this.isPro() && !!this.settings.lookupAiEnabled && this.askReadiness() === 'ready';
  }

  // ---------------- Book summary (v0.14.0) ----------------

  // Reads the book file itself: its own description and (EPUB) chapter
  // titles. Used for "Use the book's description" on books added before
  // v0.14.0, and as the material for "Write with AI".
  async bookFileDetails(bookFile) {
    const fm = new ReadingStore(this.app, this).getFm(bookFile);
    if (!fm.file_path) return { description: null, chapters: [] };
    try {
      const buf = Buffer.from(await this.app.vault.adapter.readBinary(fm.file_path));
      const format = fm.format || sniffBookFormat(buf);
      const chapters = format === 'epub' ? getEpubToc(buf).map((e) => e.title) : [];
      return { description: extractBookDescription(buf, format), chapters };
    } catch (err) {
      console.error('Reading Vault: could not read the book file', err);
      return { description: null, chapters: [] };
    }
  }

  // Pro "Write with AI": returns { text, label } where label is what the
  // Detail page shows and the note keeps, e.g. "Claude Sonnet 5 · Anthropic
  // · 2026-09-24". Uses the same service, key and model as Ask the book.
  async writeSummaryWithAi(bookFile, now = new Date()) {
    if (!this.isPro()) throw new Error('Writing a summary with AI comes with Pro.');
    if (this.askReadiness() !== 'ready') throw new Error('Switch on Ask the book and add a key in Settings → Reading Vault first.');
    const store = new ReadingStore(this.app, this);
    const fm = store.getFm(bookFile);
    const current = await store.getSummary(bookFile);
    const details = await this.bookFileDetails(bookFile);
    const description = current.source === 'book' && current.text ? current.text : details.description;
    const provider = this.settings.askProvider;
    const model = this.askModel(provider);
    const user = buildSummaryMessage({ title: fm.title || bookFile.basename, author: fm.author, description, chapters: details.chapters });
    const res = await this.askComplete(provider, model, SUMMARY_SYSTEM_PROMPT, user);
    const text = String(res.text || '').trim();
    if (!text) throw new Error('The AI service sent back an empty summary. Try again.');
    const info = this.askModelInfo(provider, model);
    return { text, label: [info.name, ASK_PROVIDERS[provider].short, localDayKey(now)].filter(Boolean).join(' · ') };
  }

  // ---------------- Ask the book (v0.10.0) ----------------

  // One place that says whether Pro features are unlocked. Today that's the
  // same code switch as the Dashboard (on, pending the checkout decision).
  isPro() {
    // No public key yet: John's own copy has Pro for everyone; a public copy
    // stays locked (and check-release.js refuses to let it ship).
    if (!this.proPublicKeys().length) return PRO_BUILD === 'local' && !!DASHBOARD_PRO_UNLOCKED;
    return !!this.proLicense();
  }

  // Overridable in tests. Empty until `npm run pro:init` fills it in.
  proPublicKeys() { return PRO_PUBLIC_KEYS; }

  // The saved key, checked once and remembered: { serial } or null.
  proLicense() {
    const key = this.settings.proKey || '';
    if (this._proChecked !== key) {
      this._proChecked = key;
      const res = key ? verifyProKey(key, this.proPublicKeys()) : { ok: false };
      this._proLicense = res.ok ? { serial: res.serial } : null;
    }
    return this._proLicense;
  }

  // Saves a key only when it checks out. Returns verifyProKey's result.
  async setProKey(key) {
    const res = verifyProKey(key, this.proPublicKeys());
    if (!res.ok) return res;
    this.settings.proKey = String(key).replace(/\s+/g, '');
    await this.saveSettings();
    this.refreshAfterProChange();
    return res;
  }

  async removeProKey() {
    delete this.settings.proKey;
    await this.saveSettings();
    this.refreshAfterProChange();
  }

  // Everything that shows a Pro lock redraws with the new plan.
  refreshAfterProChange() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => { if (leaf.view && leaf.view.render && leaf.view.screen !== 'reader') leaf.view.render(); });
    if (typeof this.refreshDashboards === 'function') this.refreshDashboards();
  }

  // Obsidian's secure storage (1.11.4+) keeps secrets in the computer's own
  // keychain, on this device only. Without it, Ask never stores a key.
  askSecretsAvailable() {
    const ss = this.app.secretStorage;
    return !!(ss && typeof ss.getSecret === 'function' && typeof ss.setSecret === 'function');
  }

  askKey(provider) {
    if (!this.askSecretsAvailable() || !ASK_PROVIDERS[provider]) return null;
    try {
      const v = this.app.secretStorage.getSecret(ASK_PROVIDERS[provider].secretId);
      return v && String(v).trim() ? String(v).trim() : null;
    } catch { return null; }
  }

  // Adding a key needs Pro (John, 2026-09-24). An empty value removes it.
  setAskKey(provider, value) {
    if (!this.askSecretsAvailable() || !ASK_PROVIDERS[provider]) return false;
    // Removing a key always works, with or without Pro (QA fix v0.17.2).
    if (!this.isPro() && String(value || '').trim()) return false;
    this.app.secretStorage.setSecret(ASK_PROVIDERS[provider].secretId, String(value || '').trim());
    if (this.askModelCache) delete this.askModelCache[provider];
    return true;
  }

  askModel(provider) {
    const saved = this.settings.askModels && this.settings.askModels[provider];
    return saved || ASK_PROVIDERS[provider].defaultModel || null;
  }

  // Ready to ask: Pro, switched on, secure storage present, a key for the
  // chosen service, and a model picked.
  askReadiness() {
    if (!this.isPro()) return 'locked';
    if (!this.askSecretsAvailable()) return 'no-secure-storage';
    const p = this.settings.askProvider;
    if (!this.settings.askEnabled || !ASK_PROVIDERS[p] || !this.askKey(p)) return 'no-key';
    if (!this.askModel(p)) return 'no-model';
    return 'ready';
  }

  async askHttp(provider, params) {
    let res;
    try {
      res = await requestUrl({ ...params, throw: false });
    } catch (err) {
      console.error('Reading Vault: Ask request failed', err);
      const e = new Error(askErrorMessage(provider, 0));
      e.status = 0;
      throw e;
    }
    if (res.status >= 400) {
      const e = new Error(askErrorMessage(provider, res.status));
      e.status = res.status;
      throw e;
    }
    return res.json;
  }

  askHeaders(provider, key) {
    if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    const h = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    if (provider === 'openrouter') h['X-Title'] = 'Reading Vault';
    return h;
  }

  // The model list for the Settings dropdown -- [{ id, name, price }], price
  // in US$ per million tokens [input, output] when the service says.
  async askListModels(provider) {
    const key = this.askKey(provider);
    if (!key) return [];
    let list = [];
    if (provider === 'anthropic') {
      const j = await this.askHttp(provider, { url: 'https://api.anthropic.com/v1/models?limit=100', method: 'GET', headers: this.askHeaders(provider, key) });
      list = (j && j.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id, price: askAnthropicPrice(m.id) }));
    } else if (provider === 'openai') {
      const j = await this.askHttp(provider, { url: 'https://api.openai.com/v1/models', method: 'GET', headers: this.askHeaders(provider, key) });
      list = (j && j.data || []).map((m) => m.id).filter(isOpenAiChatModel).sort().map((id) => ({ id, name: id, price: null }));
    } else if (provider === 'openrouter') {
      const j = await this.askHttp(provider, { url: 'https://openrouter.ai/api/v1/models', method: 'GET', headers: this.askHeaders(provider, key) });
      list = (j && j.data || []).map((m) => {
        const pin = m.pricing ? Number(m.pricing.prompt) : NaN;
        const pout = m.pricing ? Number(m.pricing.completion) : NaN;
        return { id: m.id, name: m.name || m.id, price: Number.isFinite(pin) && Number.isFinite(pout) ? [pin * 1e6, pout * 1e6] : null };
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    this.askModelCache = this.askModelCache || {};
    this.askModelCache[provider] = list;
    return list;
  }

  // "Test": does the service accept this key? OpenRouter's model list is
  // public, so it has its own key check.
  async askTestKey(provider) {
    const key = this.askKey(provider);
    if (!key) throw new Error('Add a key first.');
    // Never online while Ask is off (QA fix v0.17.3), as Settings promises.
    if (!this.settings.askEnabled) throw new Error('Turn on Ask first.');
    if (provider === 'openrouter') {
      await this.askHttp(provider, { url: 'https://openrouter.ai/api/v1/key', method: 'GET', headers: this.askHeaders(provider, key) });
    }
    return this.askListModels(provider);
  }

  askModelInfo(provider, model) {
    const list = (this.askModelCache && this.askModelCache[provider]) || [];
    const hit = list.find((m) => m.id === model);
    const niceAnthropic = (id) => String(id).replace(/^claude-/, 'Claude ').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')
      .replace(/Claude (\w)/, (m, c) => `Claude ${c.toUpperCase()}`);
    return {
      name: hit ? hit.name : (provider === 'anthropic' ? niceAnthropic(model) : model),
      price: hit && hit.price ? hit.price : (provider === 'anthropic' ? askAnthropicPrice(model) : null),
    };
  }

  // One question, one answer: { text, inputTokens, outputTokens }.
  async askComplete(provider, model, system, user) {
    const key = this.askKey(provider);
    if (!key) throw new Error('Add a key in Settings → Reading Vault first.');
    if (provider === 'anthropic') {
      const j = await this.askHttp(provider, {
        url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: this.askHeaders(provider, key),
        body: JSON.stringify({ model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] }),
      });
      if (j.stop_reason === 'refusal') throw new Error('The model declined to answer this one. Try asking another way.');
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
      const u = j.usage || {};
      return { text, inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0 };
    }
    const url = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
    const j = await this.askHttp(provider, {
      url, method: 'POST', headers: this.askHeaders(provider, key),
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const choice = j.choices && j.choices[0];
    const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
    const u = j.usage || {};
    return { text, inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 };
  }

  openOwnSettings() {
    // Settings can't show over a full screen book (v0.15.0).
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf && leaf.view && leaf.view.fullScreen) leaf.view.exitFullScreen();
    const s = this.app.setting;
    if (s && typeof s.open === 'function') {
      s.open();
      if (typeof s.openTabById === 'function') s.openTabById(this.manifest.id);
    } else {
      new Notice('Open Settings → Community plugins → Reading Vault.');
    }
  }

  // ---------------- Highlight review (v0.9.0) ----------------

  async openReview() {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const view = leaf && leaf.view;
    if (view && typeof view.startReview === 'function') view.startReview();
  }

  reviewDoneToday(now) {
    const d = this.settings.reviewDay;
    return d && d.date === localDayKey(now) ? (Number(d.done) || 0) : 0;
  }

  async noteReviewDone(now) {
    const key = localDayKey(now);
    this.settings.reviewDay = { date: key, done: this.reviewDoneToday(now) + 1 };
    await this.saveSettings();
  }

  // What the Today line, the Dashboard card and the review's own "done"
  // screen show. ready = today's set still to do; tomorrow = how many will
  // be ready tomorrow (capped at the daily number); nextDay = the earliest
  // future due day when nothing is due tomorrow.
  reviewSummary(now) {
    const all = new ReadingStore(this.app, this).listHighlights();
    const per = this.settings.reviewPerDay || 5;
    const todayKey = localDayKey(now);
    const tomorrowKey = localDayKey(addLocalDays(now, 1));
    const doneToday = this.reviewDoneToday(now);
    const inReview = all.filter(isInReview);
    const later = inReview.map(reviewDueKey).filter((k) => k && k > tomorrowKey).sort();
    const last = this.settings.reviewDay && this.settings.reviewDay.date ? parseDayKey(this.settings.reviewDay.date) : null;
    return {
      linked: all.filter((h) => h.status === 'linked').length,
      inReview: inReview.length,
      ready: planReviewQueue(all, todayKey, per, doneToday).length,
      tomorrow: Math.min(per, dueForReview(all, tomorrowKey).length),
      nextDay: later.length ? parseDayKey(later[0]) : null,
      lastReviewed: last,
      doneToday,
    };
  }

  // Opens a book in the Reading tab (Reader or Detail) from the dashboard.
  async openBookFromDashboard(file, screen) {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const view = leaf && leaf.view;
    if (view && typeof view.openBook === 'function') view.openBook(file, screen);
  }

  refreshDashboards() {
    if (this._dashRefreshTimer) window.clearTimeout(this._dashRefreshTimer);
    this._dashRefreshTimer = window.setTimeout(() => {
      this._dashRefreshTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
        if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
      }
    }, 80);
  }

  // readingSummary -- everything the dashboard and the Library strip show,
  // worked out in one place from the recorded sessions + book notes, for
  // the LOCAL day containing `now`.
  readingSummary(now) {
    const st = this.settings;
    const rec = this.sessionRecorder;
    const sessions = rec && Array.isArray(rec.sessions) ? rec.sessions : [];
    const { days, bookLast, bookFirst, first, longest } = summarizeSessions(sessions);
    const listenCounts = !!st.listeningCountsTowardGoals;
    const goalMin = (e) => e.read + (listenCounts ? e.listen : 0);
    const today = addLocalDays(now, 0);
    const todayDay = days.get(localDayKey(today)) || null;
    const streak = computeStreaks(days, today, goalMin);
    const pace = computeReadingPaceFrom(sessions, null);

    const store = new ReadingStore(this.app, this);
    const books = store.listBooks();
    const year = today.getFullYear();
    const finishedThisYear = books
      .filter((b) => b.status === 'finished' && b.date_finished)
      .map((b) => ({ ...b, finishedOn: parseDayKey(String(b.date_finished)) }))
      .filter((b) => b.finishedOn && b.finishedOn.getFullYear() === year)
      .sort((a, b) => b.finishedOn - a.finishedOn);
    let bookDays = 0; let bookDaysN = 0;
    for (const b of finishedThisYear) {
      const f = bookFirst.get(b.file.path);
      if (!f) continue;
      bookDays += Math.max(1, Math.round((b.finishedOn - addLocalDays(f, 0)) / 86400000) + 1);
      bookDaysN += 1;
    }
    // "Currently reading" = marked Reading, or started (has progress) and
    // not finished/abandoned -- e.g. a book carried over from A3 with
    // progress but still marked To Read. Untouched for
    // DASH_PAUSED_AFTER_DAYS -> shown as paused, listed last.
    const pausedBefore = now.getTime() - DASH_PAUSED_AFTER_DAYS * 86400000;
    const currentBooks = books
      .filter((b) => b.status === 'reading'
        || (b.status !== 'finished' && b.status !== 'abandoned' && typeof b.progress_percent === 'number' && b.progress_percent > 0))
      .map((b) => {
        const fromNote = b.progress_updated_at ? new Date(b.progress_updated_at) : null;
        const fromSessions = bookLast.get(b.file.path) || null;
        let lastActive = fromNote && !Number.isNaN(fromNote.getTime()) ? fromNote : null;
        if (fromSessions && (!lastActive || fromSessions > lastActive)) lastActive = fromSessions;
        return { ...b, lastActive, paused: !!lastActive && lastActive.getTime() < pausedBefore };
      })
      .sort((a, b) => (a.paused - b.paused) || ((b.lastActive ? b.lastActive.getTime() : 0) - (a.lastActive ? a.lastActive.getTime() : 0)));
    const closest = currentBooks
      .filter((b) => typeof b.progress_percent === 'number')
      .sort((a, b) => b.progress_percent - a.progress_percent)[0] || null;
    return {
      days,
      firstDay: first ? addLocalDays(first, 0) : null,
      goalMin,
      todayDay,
      todayMinutes: todayDay ? todayDay.read + todayDay.listen : 0,
      todayGoalMinutes: todayDay ? goalMin(todayDay) : 0,
      todayPages: todayDay ? todayDay.pages : 0,
      streak,
      pace,
      longest,
      finishedThisYear,
      averageBookDays: bookDaysN ? Math.round(bookDays / bookDaysN) : null,
      currentBooks,
      closestBook: closest ? { title: closest.title || closest.file.basename } : null,
      libraryCount: books.length,
      inProgressCount: books.filter((b) => b.status === 'reading').length,
    };
  }

  // checkReadingReminder -- a plain Notice, at most once a local day, at or
  // after the set time, only while the daily goal isn't met yet. Off by
  // default. Nothing is scheduled outside Obsidian: if Obsidian is closed
  // at that time, there is simply no reminder.
  checkReadingReminder(now) {
    const st = this.settings;
    if (!st.reminderEnabled) return;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(st.reminderTime || ''));
    if (!m) return;
    const todayKey = localDayKey(now);
    if (st.reminderLastShown === todayKey) return;
    if (now.getHours() * 60 + now.getMinutes() < Number(m[1]) * 60 + Number(m[2])) return;
    const sum = this.readingSummary(now);
    const goal = st.goalDailyMinutes;
    if (sum.todayGoalMinutes >= goal) return;
    st.reminderLastShown = todayKey;
    this.saveSettings();
    const done = Math.round(sum.todayGoalMinutes);
    new Notice(done > 0
      ? `Reading: ${done} of ${goal} minutes so far today. There's still time for a few pages.`
      : `Reading: nothing yet today toward your ${goal} minutes. There's still time for a few pages.`, 15000);
  }

  // ---------------- voices (settings page + reader) ----------------

  readingLanguage() {
    const lang = this.settings.ttsLanguage || 'en';
    if (lang === 'en') return 'en';
    // A language whose voices were removed from the Mac falls back to English.
    return this.systemVoices().some((v) => this.langOf(v) === lang) ? lang : 'en';
  }

  langOf(voice) { return String(voice.lang || '').split(/[-_]/)[0].toLowerCase(); }

  systemVoices() {
    return window.speechSynthesis ? (window.speechSynthesis.getVoices() || []) : [];
  }

  // Languages the Mac has voices for, other than English (English is Kokoro).
  systemLanguages() {
    const codes = [...new Set(this.systemVoices().map((v) => this.langOf(v)).filter((c) => c && c !== 'en'))];
    return codes.map((code) => ({ code, label: this.languageLabel(code) })).sort((a, b) => a.label.localeCompare(b.label));
  }

  languageLabel(code) {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
  }

  // This language's { ticked, default }, created on first use: every one of
  // the Mac's voices for it starts ticked.
  // English is the natural (Kokoro) voices with Pro, and the Mac's own
  // English voices without (v0.16.0, John 2026-09-24); each keeps its own
  // ticks, so upgrading or not never loses a choice.
  voiceChoice(lang) {
    const all = this.settings.ttsVoices || (this.settings.ttsVoices = {});
    const key = this.voiceKey(lang);
    // A Mac voice list that wasn't ready yet the first time is filled in later.
    if (!all[key] || (key !== 'en' && !all[key].ticked.length)) {
      const ids = key === 'en' ? KOKORO_VOICES.map((id) => `kokoro:${id}`) : this.systemVoices().filter((v) => this.langOf(v) === lang).map((v) => v.voiceURI);
      all[key] = { ticked: ids, default: ids[0] || null };
    }
    const c = all[key];
    if (!c.ticked.includes(c.default)) c.default = c.ticked[0] || null;
    return c;
  }

  voiceKey(lang) { return lang === 'en' && !this.naturalVoicesUnlocked() ? 'en-mac' : lang; }

  // The natural (Kokoro) voices read books with Pro only (v0.16.0). Free
  // users can still download them and hear samples in Settings.
  naturalVoicesUnlocked() { return this.isPro(); }

  // Display details for a ticked voice id (Kokoro or system).
  voiceInfo(id) {
    if (typeof id === 'string' && id.startsWith('kokoro:')) {
      const k = KOKORO_ALL_VOICES.find((x) => x[0] === id.slice(7));
      return k ? { kokoro: true, id, name: k[1], label: `Kokoro · ${k[0]}`, lang: k[2] === 'UK' ? 'en-GB' : 'en-US', accent: k[2] === 'UK' ? 'British' : 'American', gender: k[3], best: !!k[4] } : null;
    }
    const v = this.systemVoices().find((x) => x.voiceURI === id);
    return v ? { kokoro: false, id, name: v.name, label: v.name, lang: v.lang, accent: this.regionLabel(v.lang), voice: v } : null;
  }

  regionLabel(lang) {
    const region = String(lang || '').split(/[-_]/)[1];
    if (!region) return this.languageLabel(this.langOf({ lang }));
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(region.toUpperCase()) || region; } catch { return region; }
  }

  // The Mac's own default voice for a language (used when Kokoro can't load).
  defaultSystemVoice(lang) {
    const voices = this.systemVoices().filter((v) => this.langOf(v) === lang);
    return voices.find((v) => v.default) || voices[0] || this.systemVoices()[0] || null;
  }

  // ---------------- Kokoro engine ----------------

  // Loads once per Obsidian session. First use downloads the model with a
  // progress notice.
  kokoroLoad() {
    if (this.kokoroLoading) return this.kokoroLoading;
    // A download shows a progress notice; loading an already-downloaded
    // model (well under a second) stays quiet.
    const notice = this.kokoroStatus().downloaded ? null : new Notice('Loading the Kokoro voice…', 0);
    this.kokoroLoading = (async () => {
      const path = require('path');
      const fs = require('fs');
      if (!fs.existsSync(path.join(KOKORO_HOME, 'node_modules', 'kokoro-js'))) throw new Error(`kokoro-js is not installed in ${KOKORO_HOME}`);
      const req = require('module').createRequire(path.join(KOKORO_HOME, 'package.json'));
      const transformers = req('@huggingface/transformers');
      // Inside Obsidian the library believes it's in a browser; point its
      // download cache at the folder outside the vault instead.
      transformers.env.cacheDir = path.join(KOKORO_HOME, 'models');
      transformers.env.useFSCache = true;
      transformers.env.useBrowserCache = false;
      transformers.env.allowRemoteModels = true;
      const { KokoroTTS } = req('kokoro-js');
      const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
        dtype: KOKORO_DTYPE,
        device: 'cpu',
        progress_callback: (p) => {
          if (notice && p && p.status === 'progress' && /\.onnx$/.test(p.file || '') && Number.isFinite(p.progress)) {
            notice.setMessage(`Downloading the Kokoro voice (about 90 MB, first time only)… ${Math.round(p.progress)}%`);
          }
        },
      });
      this.kokoroTts = tts;
      return tts;
    })();
    const loading = this.kokoroLoading;
    if (notice) loading.then(() => notice.hide(), () => notice.hide());
    // A failed load (a dropped download, say) isn't remembered: the next
    // Listen tries again instead of failing until Obsidian restarts.
    loading.catch(() => { if (this.kokoroLoading === loading) this.kokoroLoading = null; });
    return loading;
  }

  // Load the model in the background ahead of first use -- only when it is
  // already on this Mac (never starts a download unasked) and never at
  // Obsidian startup: called when the settings page or a reader opens.
  kokoroWarmUp() {
    if (this.kokoroLoading || this.kokoroFailed) return;
    const st = this.kokoroStatus();
    if (!st.installed || !st.downloaded) return;
    this.kokoroLoad().catch(() => {});
  }

  // Audio for one sentence at the current speed, generated in order through
  // a single queue and cached briefly so lookahead is reused.
  kokoroKey(text, voiceId, speed = this.settings.ttsSpeed || 1) {
    return `${voiceId}|${speed}|${text}`;
  }

  kokoroAudioFor(text, voiceId, speed = this.settings.ttsSpeed || 1) {
    const key = this.kokoroKey(text, voiceId, speed);
    if (!this.kokoroCache) this.kokoroCache = new Map();
    const epoch = this.kokoroEpoch || 0;
    const known = this.kokoroCache.get(key);
    if (known) { known.epoch = epoch; return known.promise; }
    const entry = { epoch };
    entry.promise = (this.kokoroQueue || Promise.resolve()).then(async () => {
      // Lookahead left over from reading that has since stopped: skip it,
      // so it doesn't hold up what is wanted now (it would take seconds).
      if (entry.epoch !== (this.kokoroEpoch || 0)) throw new Error(KOKORO_CANCELLED);
      const tts = await this.kokoroLoad();
      return tts.generate(text, { voice: voiceId, speed });
    });
    this.kokoroQueue = entry.promise.catch(() => {});
    this.kokoroCache.set(key, entry);
    entry.promise.catch(() => { if (this.kokoroCache.get(key) === entry) this.kokoroCache.delete(key); });
    while (this.kokoroCache.size > 8) this.kokoroCache.delete(this.kokoroCache.keys().next().value);
    return entry.promise;
  }

  // Called when reading stops or pauses: audio queued but not yet started
  // is dropped unless something asks for it again.
  kokoroCancelPending() {
    this.kokoroEpoch = (this.kokoroEpoch || 0) + 1;
  }

  // Is the model file on this Mac? { installed, downloaded, bytes }
  kokoroStatus() {
    const fs = require('fs');
    const path = require('path');
    const installed = fs.existsSync(path.join(KOKORO_HOME, 'node_modules', 'kokoro-js'));
    const file = path.join(KOKORO_MODEL_DIR, 'onnx', 'model_quantized.onnx');
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { bytes = 0; }
    return { installed, downloaded: bytes > 0, bytes };
  }

  // Throw away the downloaded model and fetch it again (for a missing or
  // damaged file). The voice software itself is left alone.
  async kokoroRedownload() {
    if (this.kokoroTts) { try { await this.kokoroTts.model.dispose(); } catch { /* already gone */ } }
    this.kokoroTts = null;
    this.kokoroLoading = null;
    this.kokoroFailed = false;
    this.kokoroCache = new Map();
    this.kokoroQueue = null;
    require('fs').rmSync(KOKORO_MODEL_DIR, { recursive: true, force: true });
    return this.kokoroLoad();
  }

  // ▶ on the settings page: a short line in the voice. One sample at a
  // time; stops any reading first so the two don't talk over each other.
  // previewId is the voice whose sample is playing (or being made), so the
  // settings page can show ■ on it; onPreviewChange tells the page.
  async previewVoice(id) {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => { if (leaf.view && leaf.view.stopPlayback) leaf.view.stopPlayback(); });
    this.stopPreview();
    const info = this.voiceInfo(id);
    if (!info) return;
    const token = this.previewToken;
    this.setPreview(id);
    const done = () => { if (token === this.previewToken) this.setPreview(null); };
    try {
      if (info.kokoro) {
        await this.kokoroPreview(info, token);
        done();
        return;
      }
      const utter = new SpeechSynthesisUtterance(PREVIEW_LINES[this.langOf(info.voice)] || `${info.name}.`);
      utter.voice = info.voice;
      utter.lang = info.voice.lang;
      utter.rate = this.settings.ttsSpeed || 1;
      utter.onend = done;
      utter.onerror = done;
      window.speechSynthesis.speak(utter);
    } catch (err) {
      done();
      throw err;
    }
  }

  // Kokoro sample. Making the whole 4-second line takes ~2.5 s on John's M2,
  // so: (1) a clip already made is saved next to the model (outside the
  // vault) and plays at once; (2) the first time, the short "Hi, I'm Heart."
  // is made and played first (~0.7 s) while the rest is made behind it.
  async kokoroPreview(info, token) {
    const voiceId = info.id.slice(7);
    const cached = this.readSampleClip(voiceId);
    if (cached) { await this.playClip(cached, token); return; }
    const parts = [`Hi, I'm ${info.name}.`, 'This is how I sound reading your books aloud.'];
    const jobs = parts.map((t) => this.kokoroAudioFor(t, voiceId, 1));
    const clips = [];
    for (const job of jobs) {
      const audio = await job;
      clips.push(audio.audio);
      if (token !== this.previewToken) break; // stopped: keep making the clip for next time, just don't play
      await this.playClip(audio.audio, token);
    }
    // Save the full line once both parts exist, even if playback was stopped.
    Promise.all(jobs).then((all) => this.writeSampleClip(voiceId, all.map((a) => a.audio))).catch(() => {});
  }

  // Plays 24 kHz mono samples; resolves when finished or stopped.
  playClip(samples, token) {
    return new Promise((resolve) => {
      if (token !== this.previewToken) { resolve(); return; }
      if (!this.kokoroAudioCtx) this.kokoroAudioCtx = new AudioContext();
      const ctx = this.kokoroAudioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const buffer = ctx.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => { if (this.previewSource === src) this.previewSource = null; resolve(); };
      this.previewSource = src;
      src.start();
    });
  }

  sampleClipPath(voiceId) {
    return require('path').join(KOKORO_HOME, 'samples', `${voiceId}.f32`);
  }

  readSampleClip(voiceId) {
    try {
      const buf = require('fs').readFileSync(this.sampleClipPath(voiceId));
      const out = new Float32Array(buf.byteLength / 4);
      new Uint8Array(out.buffer).set(buf);
      return out.length ? out : null;
    } catch { return null; }
  }

  writeSampleClip(voiceId, parts) {
    try {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const joined = new Float32Array(total);
      let at = 0;
      for (const p of parts) { joined.set(p, at); at += p.length; }
      const fs = require('fs');
      fs.mkdirSync(require('path').join(KOKORO_HOME, 'samples'), { recursive: true });
      fs.writeFileSync(this.sampleClipPath(voiceId), Buffer.from(joined.buffer));
    } catch (err) { console.error('Reading Vault: could not save the voice sample', err); }
  }

  setPreview(id) {
    this.previewId = id;
    if (this.onPreviewChange) this.onPreviewChange();
  }

  stopPreview() {
    this.previewToken = (this.previewToken || 0) + 1;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const src = this.previewSource;
    this.previewSource = null;
    if (src) { try { src.stop(); } catch { /* not started */ } }
    if (this.previewId) this.setPreview(null);
  }

  onunload() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    // Free the Kokoro model's memory (it lives in the ONNX runtime, not JS).
    if (this.kokoroTts) { try { this.kokoroTts.model.dispose(); } catch { /* already gone */ } this.kokoroTts = null; }
    if (this.kokoroAudioCtx) { try { this.kokoroAudioCtx.close(); } catch { /* already closed */ } this.kokoroAudioCtx = null; }
    // A clean disable/reload/quit ends whatever reading session is running
    // rather than leaving it to the crash guard's coarser window.
    if (this.sessionRecorder) this.sessionRecorder.endCurrent();
  }
};
