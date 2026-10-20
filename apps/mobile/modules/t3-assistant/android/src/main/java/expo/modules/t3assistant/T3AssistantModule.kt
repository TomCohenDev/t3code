package expo.modules.t3assistant

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import android.speech.RecognizerIntent
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AssistantModule : Module() {
  private var pendingSpeech: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("T3Assistant")
    Events(CAPTURE_EVENT)

    OnStartObserving(CAPTURE_EVENT) {
      AssistantCapture.listener = { sendEvent(CAPTURE_EVENT, it.toMap()) }
    }
    OnStopObserving(CAPTURE_EVENT) {
      AssistantCapture.listener = null
    }

    Function("getCapture") { AssistantCapture.current?.toMap() }

    Function("close") {
      (appContext.currentActivity as? AssistantActivity)?.finish()
    }

    Function("openAssistantSettings") {
      val context = appContext.reactContext ?: return@Function null
      context.startActivity(
        Intent(Settings.ACTION_VOICE_INPUT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }

    /** Opens the system speech dialog. Resolves with the text, or null when the user cancels. */
    AsyncFunction("recognizeSpeech") { promise: Promise ->
      val activity = appContext.currentActivity
        ?: throw CodedException("ERR_NO_ACTIVITY", "The panel is not open.", null)
      pendingSpeech?.resolve(null)
      pendingSpeech = promise
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      try {
        activity.startActivityForResult(intent, SPEECH_REQUEST_CODE)
      } catch (error: ActivityNotFoundException) {
        pendingSpeech = null
        promise.reject(CodedException("ERR_NO_SPEECH", "This phone has no speech recognition app.", error))
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != SPEECH_REQUEST_CODE) return@OnActivityResult
      val promise = pendingSpeech ?: return@OnActivityResult
      pendingSpeech = null
      promise.resolve(
        payload.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
      )
    }
  }

  private fun AssistantCapture.Snapshot.toMap() = mapOf(
    "id" to id.toDouble(),
    "sourcePackage" to sourcePackage,
    "webUri" to webUri,
    "screenText" to screenText,
    "screenshotUri" to screenshotUri,
  )

  private companion object {
    const val CAPTURE_EVENT = "onCapture"
    const val SPEECH_REQUEST_CODE = 0x7433
  }
}
