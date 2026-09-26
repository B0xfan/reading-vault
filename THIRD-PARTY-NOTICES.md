# Third-party notices

Reading Vault's own code is under the PolyForm Shield License 1.0.0 (`LICENSE`).
It also contains, or downloads when you ask, the parts below. Each keeps its own
licence. None of them is under the GPL or any other copyleft licence.

## Inside the plugin (`main.js`)

The natural-voice engine, in the block marked "Kokoro engine" at the end of `main.js`:

| Part | Version | Licence | Copyright | Licence text |
|---|---|---|---|---|
| kokoro-js | 1.2.1 | Apache-2.0 | hexgrad and contributors (github.com/hexgrad/kokoro) | [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |
| @huggingface/transformers (transformers.js) | 3.8.1 | Apache-2.0 | Hugging Face | [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |
| onnxruntime-web, including its WebAssembly engine | 1.22.0-dev.20250409-89f8206ba4 | MIT | Microsoft Corporation | [licenses/onnxruntime-LICENSE.txt](licenses/onnxruntime-LICENSE.txt); code compiled into the engine: [licenses/onnxruntime-ThirdPartyNotices.txt](licenses/onnxruntime-ThirdPartyNotices.txt) |
| onnxruntime-common | 1.21.0 | MIT | Microsoft Corporation | [licenses/onnxruntime-LICENSE.txt](licenses/onnxruntime-LICENSE.txt) |
| phonemize (pronunciation rules for unfamiliar words) | 2.0.1 | MIT | Hans (github.com/hans00/phonemize) | [licenses/phonemize-LICENSE.txt](licenses/phonemize-LICENSE.txt) |

Changes made when building: the parts are bundled and minified together; the
pronunciation step kokoro-js normally gets from the `phonemizer` package (which
contains eSpeak NG, GPL) is replaced by Reading Vault's own code, so eSpeak is not
included; phonemize's large word tables are left out of the bundle and downloaded
as data instead; two lines in onnxruntime-web and phonemize are adjusted so the
engine runs inside Obsidian (see `scripts/build-kokoro-engine.js` in the plugin's
source).

The fonts in `styles.css` are under the SIL Open Font License 1.1; see [`fonts/`](fonts/).

## Downloaded when you choose the natural voices

| Part | From | Licence |
|---|---|---|
| Kokoro-82M voice model (full precision, about 325 MB) and voices, by hexgrad, converted to ONNX by onnx-community | huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX (fixed revision 1939ad2a) | Apache-2.0 |
| English pronunciation lists from misaki, by hexgrad | github.com/B0xfan/reading-vault-voices (copied from github.com/hexgrad/misaki) | Apache-2.0 |
| phonemize's English exception list | github.com/B0xfan/reading-vault-voices | MIT |
| Voice sample clips (one per voice, made with Kokoro-82M), played by ▶ in Settings | github.com/B0xfan/reading-vault-voices | Apache-2.0 |

Attribution and the exact changes for the downloaded files are in the `NOTICE`
file of github.com/B0xfan/reading-vault-voices.

## Downloaded when you press "Add sample books"

| Part | From | Licence |
|---|---|---|
| Meditations, by Marcus Aurelius, translated by George Long | standardebooks.org/ebooks/marcus-aurelius/meditations/george-long, mirrored at github.com/B0xfan/a4-reading-sample-books | CC0 1.0 (public domain) |
| Pride and Prejudice, by Jane Austen | standardebooks.org/ebooks/jane-austen/pride-and-prejudice, mirrored at github.com/B0xfan/a4-reading-sample-books | CC0 1.0 (public domain) |
| The Adventures of Sherlock Holmes, by Arthur Conan Doyle | standardebooks.org/ebooks/arthur-conan-doyle/the-adventures-of-sherlock-holmes, mirrored at github.com/B0xfan/a4-reading-sample-books | CC0 1.0 (public domain) |
| Walden, by Henry David Thoreau | standardebooks.org/ebooks/henry-david-thoreau/walden, mirrored at github.com/B0xfan/a4-reading-sample-books | CC0 1.0 (public domain) |

Each is an unmodified EPUB file from [Standard Ebooks](https://standardebooks.org/),
a volunteer project that produces carefully typeset editions of already-public-domain
books. Standard Ebooks dedicates the entirety of each ebook file to the public domain
under CC0 1.0 (see standardebooks.org/about), so no attribution is legally required;
it's given here anyway, as thanks to the project.
