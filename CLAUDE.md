# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MathCAT (Math Capable Assistive Technology) is a Rust library that converts MathML to:
- Speech strings with embedded TTS engine commands (multiple languages)
- Braille (Nemeth, UEB Technical, CMU, Vietnam, LaTeX, ASCIIMath, Swedish)
- Navigation support with multiple modes

The library outputs both `rlib` (Rust) and `cdylib` (C-compatible) formats. It's used by screen readers like NVDA and JAWS.

## Build Commands

```bash
cargo build                          # Development build
cargo build --release                # Optimized release build (with LTO)
cargo build --features include-zip   # Embed Rules as zip in binary (for WASM)
cargo test                           # Run all tests (uses opt-level=1 for speed)
cargo test <test_name>               # Run specific test
cargo test --test braille            # Run braille test module
cargo test --test languages          # Run language test module
cargo clippy                         # Lint
```

## Architecture

### Core Data Flow
```
MathML string → set_mathml() → canonicalize.rs → [infer_intent.rs] → speech.rs/braille.rs → output
```

### Key Modules (src/)

- **interface.rs**: Public API - `set_rules_dir()`, `set_mathml()`, `get_spoken_text()`, `get_braille()`, navigation commands
- **canonicalize.rs**: MathML cleanup, normalization, and repair (largest module, ~6400 lines)
- **speech.rs**: Speech rule engine and text generation
- **braille.rs**: Braille code generation for all supported codes
- **navigate.rs**: Math navigation state machine
- **infer_intent.rs**: Infers semantic intent from MathML structure
- **chemistry.rs**: Chemistry-specific speech heuristics
- **prefs.rs**: User preference management
- **xpath_functions.rs**: Custom XPath functions for rule matching
- **definitions.rs**: Loads definition files (numbers, symbols)
- **shim_filesystem.rs**: File system abstraction (supports zipped rules)

### Thread-Local State (interface.rs)
- `MATHML_INSTANCE`: Current parsed MathML
- `SPEECH_RULES` / `BRAILLE_RULES` / `NAVIGATION_RULES`: Lazy-loaded rule engines

### Rules System (Rules/)

YAML-based rules loaded at runtime:
- `Rules/Languages/{lang}/`: Speech rules per language (en, es, de, fi, id, nb, sv, vi, zh)
- `Rules/Braille/{code}/`: Braille rules per code (Nemeth, UEB, CMU, Vietnam, LaTeX, ASCIIMath)
- `Rules/Intent/`: Language-independent intent rules

Key rule files per language:
- `ClearSpeak_Rules.yaml` / `SimpleSpeak_Rules.yaml`: Speech styles
- `SharedRules/`: Common rules included by speech files
- `unicode.yaml`: ~270 common characters
- `unicode-full.yaml`: ~3000+ characters
- `definitions.yaml`: Numbers, ordinals
- `navigate.yaml`: Navigation speech

### build.rs

Creates `rules.zip` containing all YAML files when `include-zip` feature is enabled. Uses BZIP2 compression (DEFLATE for WASM).

## Testing

Tests are in `tests/` organized by:
- `tests/braille/`: Nemeth, UEB, CMU, Vietnam, LaTeX, ASCIIMath, Swedish
- `tests/Languages/`: Per-language speech tests (ClearSpeak, SimpleSpeak)
- `tests/Languages/intent/`: Language-independent intent tests

Test utilities in `tests/common/mod.rs`:
- `test(language, style, mathml, expected_speech)`: Standard speech test
- `test_braille(code, mathml, expected_braille)`: Braille test
- `test_ClearSpeak(language, pref, value, mathml, expected)`: ClearSpeak with preference

## Translation

Translations use lowercase `t:` for untranslated text, uppercase `T:` for verified translations:
```yaml
# Untranslated (needs review)
- t: "equals"

# Translated and verified
- T: "égale"
```

Use `PythonScripts/audit_translations.` to find missing/incomplete translations:
```bash
python -m audit_translations de
python -m audit_translations de --file SharedRules/default.yaml
```

## API Usage Pattern

```rust
set_rules_dir(path)?;           // MUST be called first
set_preference(name, value)?;   // Optional: configure language, speech style, etc.
set_mathml(mathml_string)?;     // Parse and canonicalize
let speech = get_spoken_text()?;
let braille = get_braille("")?;
```

## Key Preferences

- `Language`: en, es, de, fi, id, nb, sv, vi, zh-tw
- `SpeechStyle`: ClearSpeak, SimpleSpeak
- `BrailleCode`: Nemeth, UEB, CMU, Vietnam, LaTeX, ASCIIMath
- `Verbosity`: Terse, Medium, Verbose
