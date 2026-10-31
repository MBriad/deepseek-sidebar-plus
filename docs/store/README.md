# Store assets

- `logo-300.png` — 300×300 store logo (required for each language; can duplicate).
- `small-promo-440x280.png` — optional small promotional tile.
- `large-promo-1400x560.png` — optional large promotional tile.
- `make_icon.py` — regenerates the original geometric app icon at 16/32/48/128.
- `make_assets.py` — regenerates the logo/tiles from the current icon.
- `screenshots/` — six ready 1280×800 screenshots:
  - `store-01-page.png`
  - `store-02-prompts.png`
  - `store-03-pdf.png`
  - `store-04-settings.png`
  - `store-05-page-tags.png` (stale after v1.12.0: webpage tags were removed; re-shoot or drop)
  - `store-06-chatgpt.png`

The screenshots were captured before v1.12.0, so all six show the old toolbar (page-tag, bookmark and paste buttons). Re-shoot them, or crop the toolbar, before the next store submission. They show the actual extension UI with demo article/prompt/PDF content and a ChatGPT sign-in screen; no chat account is required. Do not replace them with fake chat text.

The detailed listing copy, permission justifications, and certification notes are in [`../../STORE_SUBMISSION.md`](../../STORE_SUBMISSION.md).
