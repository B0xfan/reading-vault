# Your files and privacy

**Free.** Everyone gets this.

I built Reading Vault so your reading belongs to you. Here's where everything goes, and when Reading Vault ever talks to the internet.

## Where your things are kept

Everything is a regular note or file in your vault. You can open any of it in Obsidian like any other note.

- **A note for each book.** It holds the title, author, your reading progress and your own notes.
- **A note for each highlight.** It holds the passage, its color and any note you added.
- **Book files and covers.** The EPUB and PDF files themselves, and their cover pictures.
- **Topic notes.** The notes you link highlights to (with Pro).
- **Saved words.** One note per word you save (with Pro).

You choose these folders yourself. See [Settings and folders](settings.md).

Text that comes from a book or an AI service (passages, chapter names, a book's description, summaries and answers) is saved into your notes as plain words. It reads the same, but it can't run as code in other plugins such as Dataview or Templater.

## What stays on your computer

Your reading history for the Reading Dashboard and your settings are stored with the plugin, in your vault's settings folder. They never leave your computer unless your own vault sync copies them.

## When Reading Vault goes online

Reading Vault works offline. It never sends anything about you or your reading anywhere on its own, and it has no tracking or analytics. These are the only times it connects to the internet, all started by you:

- **Ask the book, "Write with AI" summaries and "Explain in this sentence" (Pro).** These are off until you switch them on in Settings and add a key for the AI service you choose: Anthropic (api.anthropic.com), OpenAI (api.openai.com) or OpenRouter (openrouter.ai). Your key is kept in Obsidian's own secure storage, not in the plugin's settings file. Only then, and only when you ask, the plugin sends that service:
  - for Ask: your question, the book's title and author, the highlights and notes from this book, the Topic notes they link to, and the text of the chapter you're on (never the whole book). Each of these can be switched off in Settings, and "What was sent" under every answer shows exactly what went.
  - for a summary: the book's title, author, the description inside the book file, and its chapter titles (not the book's text).
  - for "Explain in this sentence": the word, the sentence it's in, and the book's title and author.
  - The "Test" button next to a key, and the list of models to choose from, also ask that service to check your key and list its models.
- **Word lookup dictionary.** When you press Download in Settings → Word lookup, the English dictionary (made from Princeton WordNet, about 5.5 MB) is downloaded once from the public GitHub repository [B0xfan/a4-reading-dictionaries](https://github.com/B0xfan/a4-reading-dictionaries), checked, and saved on your computer outside your vault. After that, lookups are offline.
- **Buy Pro.** The Buy Pro button opens the store page in your web browser.
- **User manual.** The "Manual" link in the Library and "Open manual" in Settings open this manual as a web page (b0xfan.github.io/reading-vault/manual/) in your web browser.
- **Natural voices (Pro).** When you press Download in Settings → Reading Vault, the voice model (about 325 MB, once) and each voice you use (about half a megabyte) are downloaded from Hugging Face (huggingface.co, the public Kokoro-82M files, Apache-2.0 license), together with English pronunciation lists (about 3 MB) from the public GitHub repository [B0xfan/reading-vault-voices](https://github.com/B0xfan/reading-vault-voices). Each file is checked against a fingerprint built into the plugin, then saved on your computer outside your vault, in `Library/Application Support/a4-reading-kokoro` in your home folder on a Mac, or `AppData\Roaming\a4-reading-kokoro` on Windows (so it doesn't sync or get backed up with your notes). After that, listening is offline and your books' text never leaves your computer. The voice engine itself is inside the plugin; it is never downloaded.
- **Voice samples.** Pressing ▶ next to a natural voice in Settings plays a short sample clip (about 30 KB) from the same public repository, [B0xfan/reading-vault-voices](https://github.com/B0xfan/reading-vault-voices). It's checked the same way and kept in that same folder, so it plays without the internet next time. This works with or without Pro, and doesn't need the voice model.
- **Add sample books.** When you press "Add sample books" (in an empty Library, or the first-run welcome), four EPUB files (about 3 MB total) are downloaded once from the public GitHub repository [B0xfan/a4-reading-sample-books](https://github.com/B0xfan/a4-reading-sample-books), checked, and added to your Library as regular books. They're free, public-domain editions from [Standard Ebooks](https://standardebooks.org/). Free for everyone.

"Open in Apple Dictionary" (on a Mac) opens the dictionary app on your computer; it doesn't go online.

Checking your Pro key happens on your computer. It never goes online.

## Files kept outside your vault

Everything you make with Reading Vault (books, highlights, notes, saved words, reading history) lives inside your vault. Only these things are kept outside it, and only because you asked for them:

- **Natural voices.** The voice model and voices you download (Pro), and the short voice samples you play in Settings, are saved in a folder called `a4-reading-kokoro`: in `Library/Application Support` in your home folder on a Mac, or in `AppData\Roaming` on Windows. They stay outside the vault on purpose: at about 325 MB they would fill up Obsidian Sync, iCloud or any backup of your notes, and one download serves every vault on your computer. To remove them, quit Obsidian and delete that folder.
- **Word lookup dictionary.** The dictionary you download (about 5.5 MB) is saved in a folder called `a4-reading-dictionaries` in the same place, for the same reasons. Settings → Word lookup → Remove deletes it.
- **Export highlights, "Save file…" (Pro).** Your computer's own save window opens, and the file goes where you choose, which can be outside the vault.

The plugin only reads and writes those two folders and the file you save; it never looks anywhere else on your computer.

## Copying to the clipboard

The **Copy** buttons in Export highlights (Pro) and under an Ask the book answer (Pro) put that text on your clipboard, only when you press them. Reading Vault never reads your clipboard.

## If you stop using Reading Vault

Your notes, highlights and book files all stay where they are. They're plain notes and files, so they still open in Obsidian or any other app.
