# GrowBot Native

The native creature experience for iOS and Android. MVP 1 proves one complete path:
birth a creature, speak through a real model, use an installed offline system voice,
persist meaningful memory, and restore the same creature after a cold restart.

## Architecture

- `src/app` renders Habitat, Story, and Workshop. It does not own domain rules.
- `src/runtime` executes effects requested by `@growbot/creature-core`.
- `src/storage` keeps the soul in SQLite and model credentials in OS secure storage.
- `src/model` is the bounded OpenRouter BYOK adapter.
- `src/voice` selects a deterministic installed voice.
- `modules/growbot-voice` is the small Swift/Kotlin platform seam for local speech.

The generated `ios/` and `android/` projects are intentionally ignored. Expo prebuild
recreates them from `app.json` and the local module.

## Run

From the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter native start
```

Use a development build, not Expo Go: GrowBot includes a local native voice module.

```bash
pnpm --filter native android
pnpm --filter native ios
```

Enter an OpenRouter API key in Workshop to exercise cloud inference. The key stays in
the platform secure store. The app sends only the current utterance, the creature's
small identity summary, and bounded recent traces/memories; provider data collection
is denied and zero-data-retention is requested.

## Native release checks

```bash
pnpm --filter native exec expo prebuild --clean --no-install --platform android
cd apps/native/android
./gradlew assembleRelease --no-daemon --max-workers=2
```

On macOS with full Xcode installed:

```bash
pnpm --filter native exec expo prebuild --clean --no-install --platform ios
cd apps/native/ios
pod install
xcodebuild -workspace GrowBot.xcworkspace -scheme GrowBot \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

See `docs/native-mvp1-proof.md` for the acceptance contract and current evidence.
