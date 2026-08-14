# Native MVP 1 proof: Wakes and Remembers

This matrix records proof, not aspiration. The implementation issue is
[`jordanhindo/GrowBot#1`](https://github.com/jordanhindo/GrowBot/issues/1).

| Outcome | Proof |
| --- | --- |
| Birth becomes real only after save | Runtime tests cover save success/failure; packaged Android release birthed “Moss” |
| Same creature returns | Cold-stop/relaunch of the release APK restored “Moss” from SQLite |
| Real model boundary | Adapter tests assert a real OpenRouter request, strict schema, bounded context, ZDR request, and actionable failures |
| Safe response contract | Core tests reject malformed/off-menu output and clamp `say` to 18 words |
| Free local voice | Swift uses `AVSpeechSynthesizer`; Kotlin uses offline `TextToSpeech` voices; native Android debug and release compilation passed |
| Durable Story truth | Tests prove memory appears only after persistence succeeds and remains absent on failure |
| Professional native shell | Packaged Android release renders Habitat, Story, Workshop, birth, dark/light tokens, safe areas, native tabs, and accessibility labels |
| Cross-platform bundle | Expo production export passed for iOS and Android |
| iOS native compile | Required macOS CI gate; no full Xcode toolchain exists on the development Mac |
| Physical-device audio | Required before release; emulator compilation cannot prove speaker quality, interruptions, or installed voice inventory |
| Live paid inference | Requires an owner-supplied OpenRouter key; no credential is committed or harvested for CI |

## Automated gates

```bash
pnpm verify
pnpm native:export
```

Android native gates additionally compile the custom Kotlin module and build a packaged
APK. iOS CI prebuilds, installs pods, and compiles the generated workspace without code
signing. Hardware-only checks remain visible rather than being replaced with mocks.

## Android release captures

- [Birth](proof/native-mvp1/android-birth.png)
- [Habitat](proof/native-mvp1/android-habitat.png)
- [Story](proof/native-mvp1/android-story.png)
- [Cold restore](proof/native-mvp1/android-cold-restore.png)
