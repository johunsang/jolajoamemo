# JOLAJOA_MEMO

> AI-powered smart notepad that automatically organizes your messy notes.

![License](https://img.shields.io/badge/license-MIT-black)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black)

## Features

- **PASTE_ANYTHING** - Contact lists, meeting notes, code snippets. AI automatically formats and categorizes.
- **ASK_ANYTHING** - Natural language search with RAG. "What's John's phone number?"
- **AUTO_MERGE** - Similar content gets automatically merged. No duplicates.
- **LOCAL_FIRST** - All data in SQLite. Export/import JSON backups.
- **TRACK_USAGE** - Real-time token count and cost display.
- **MULTILINGUAL** - EN, KO, ES, DE, FR

## Tech Stack

- **Tauri 2.0** - Framework
- **Rust** - Backend
- **React + TypeScript** - Frontend
- **SQLite** - Database
- **Google Gemini** - AI Engine

## Installation

### Download

- [macOS (Apple Silicon)](https://github.com/hunsangjo/jolajoamemo/releases/latest)
- [macOS (Intel)](https://github.com/hunsangjo/jolajoamemo/releases/latest)
- [Windows](https://github.com/hunsangjo/jolajoamemo/releases/latest)

### Requirements

- Google Gemini API Key ([Get one here](https://makersuite.google.com/app/apikey))

## Development

```bash
# Install dependencies
npm install

# Run dev server
npm run tauri dev

# Build for production
npm run tauri build
```

## Auto Update

The app automatically checks for updates on launch. Updates are signed and verified.

## License

MIT
