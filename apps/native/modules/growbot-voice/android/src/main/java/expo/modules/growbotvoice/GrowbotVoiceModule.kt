package expo.modules.growbotvoice

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class GrowbotVoiceModule : Module() {
  private var engine: TextToSpeech? = null
  private var initialized = false
  private var initializePromise: Promise? = null
  private val speechPromises = mutableMapOf<String, Promise>()

  override fun definition() = ModuleDefinition {
    Name("GrowbotVoice")

    AsyncFunction("initialize") { promise: Promise ->
      if (initialized) {
        promise.resolve(null)
        return@AsyncFunction
      }

      initializePromise = promise
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "Android application context is unavailable.", null)
        return@AsyncFunction
      }

      engine = TextToSpeech(context) { status ->
        if (status == TextToSpeech.SUCCESS) {
          initialized = true
          installProgressListener()
          initializePromise?.resolve(null)
        } else {
          initializePromise?.reject(
            "ERR_TTS_INIT",
            "Android text to speech could not initialize.",
            null,
          )
        }
        initializePromise = null
      }
    }

    AsyncFunction("listVoices") {
      check(initialized) { "GrowbotVoice must be initialized first." }
      return@AsyncFunction engine?.voices
        ?.filter { !it.isNetworkConnectionRequired }
        ?.sortedWith(compareByDescending<Voice> { it.quality }.thenBy { it.name })
        ?.map { voice ->
          mapOf(
            "id" to voice.name,
            "name" to voice.name,
            "language" to voice.locale.toLanguageTag(),
            "quality" to voice.quality,
            "requiresNetwork" to voice.isNetworkConnectionRequired,
          )
        } ?: emptyList<Map<String, Any>>()
    }

    AsyncFunction("speak") {
      text: String, voiceId: String?, rate: Double, promise: Promise ->
      val tts = engine
      if (!initialized || tts == null) {
        promise.reject("ERR_TTS_NOT_READY", "Android text to speech is not ready.", null)
        return@AsyncFunction
      }

      val selected = tts.voices?.firstOrNull {
        it.name == voiceId && !it.isNetworkConnectionRequired
      }
      if (selected != null) tts.voice = selected
      tts.setSpeechRate(rate.coerceIn(0.5, 1.5).toFloat())

      val utteranceId = UUID.randomUUID().toString()
      speechPromises[utteranceId] = promise
      val result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), utteranceId)
      if (result == TextToSpeech.ERROR) {
        speechPromises.remove(utteranceId)
        promise.reject(
          "ERR_TTS_SPEAK",
          "Android text to speech rejected the utterance.",
          null,
        )
      }
    }

    AsyncFunction("stop") {
      engine?.stop()
    }

    OnDestroy {
      engine?.stop()
      engine?.shutdown()
      engine = null
      initialized = false
    }
  }

  private fun installProgressListener() {
    engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) = Unit

      override fun onDone(utteranceId: String?) {
        if (utteranceId != null) speechPromises.remove(utteranceId)?.resolve(null)
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) {
        rejectSpeech(utteranceId)
      }

      override fun onError(utteranceId: String?, errorCode: Int) {
        rejectSpeech(utteranceId)
      }
    })
  }

  private fun rejectSpeech(utteranceId: String?) {
    if (utteranceId != null) {
      speechPromises.remove(utteranceId)?.reject(
        "ERR_TTS_SPEAK",
        "Android text to speech failed.",
        null,
      )
    }
  }
}
