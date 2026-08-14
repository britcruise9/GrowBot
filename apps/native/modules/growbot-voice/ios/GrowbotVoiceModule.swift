import AVFoundation
import ExpoModulesCore

public class GrowbotVoiceModule: Module, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var speechPromises: [ObjectIdentifier: Promise] = [:]

  public func definition() -> ModuleDefinition {
    Name("GrowbotVoice")

    OnCreate {
      self.synthesizer.delegate = self
    }

    AsyncFunction("initialize") {}

    AsyncFunction("listVoices") {
      return AVSpeechSynthesisVoice.speechVoices().map { voice in
        [
          "id": voice.identifier,
          "name": voice.name,
          "language": voice.language,
          "quality": voice.quality.rawValue,
          "requiresNetwork": false,
        ] as [String: Any]
      }
    }

    AsyncFunction("speak") {
      (text: String, voiceId: String?, rate: Double, promise: Promise) in
      if self.synthesizer.isSpeaking {
        self.synthesizer.stopSpeaking(at: .immediate)
      }

      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try session.setActive(true)

      let utterance = AVSpeechUtterance(string: text)
      if let voiceId {
        utterance.voice = AVSpeechSynthesisVoice(identifier: voiceId)
      }
      utterance.rate = Float(
        max(
          Double(AVSpeechUtteranceMinimumSpeechRate),
          min(rate, Double(AVSpeechUtteranceMaximumSpeechRate))
        )
      )
      self.speechPromises[ObjectIdentifier(utterance)] = promise
      self.synthesizer.speak(utterance)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.synthesizer.stopSpeaking(at: .immediate)
    }.runOnQueue(.main)
  }

  public func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    speechPromises.removeValue(forKey: ObjectIdentifier(utterance))?.resolve(nil)
    deactivateAudioIfIdle()
  }

  public func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    speechPromises.removeValue(forKey: ObjectIdentifier(utterance))?.reject(
      "ERR_SPEECH_CANCELLED",
      "Speech was cancelled."
    )
    deactivateAudioIfIdle()
  }

  private func deactivateAudioIfIdle() {
    guard !synthesizer.isSpeaking else { return }
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: [.notifyOthersOnDeactivation]
    )
  }
}
