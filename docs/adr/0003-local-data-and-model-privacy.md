# ADR 0003: Local durable soul, secure credentials, bounded inference

- Status: accepted for MVP 1
- Date: 2026-08-14

## Decision

Store the creature soul in the app sandbox using atomic SQLite transactions. Store the
owner's OpenRouter key in iOS Keychain or Android Keystore through Expo SecureStore.
Use installed offline system text-to-speech voices by default. Send only bounded
context to the chosen model provider.

## Model egress

MVP 1 sends the current utterance, the creature's compact identity, at most eight recent
traces, and at most five durable memories. The OpenRouter request uses a strict JSON
schema, denies provider data collection, and requests zero-data-retention routing.
Those flags narrow provider handling; they are not a promise that the phone remained
offline.

## Local truth

The app does not store soul state or credentials in browser cookies or web storage.
Story reflects committed SQLite state. SecureStore backup behavior follows platform
rules and is not described as a complete soul backup. Export, restore, deletion, and
legacy migration remain explicit later outcomes rather than implied capabilities.

## Consequences

Workshop must state when a model key is absent, when a voice is local or unavailable,
and what leaves the device. Premium cloud voice and local model inference may be added
later behind real adapters without changing the creature runtime.
