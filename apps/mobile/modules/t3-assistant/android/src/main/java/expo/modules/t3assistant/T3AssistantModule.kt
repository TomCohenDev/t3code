package expo.modules.t3assistant

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.net.Uri
import android.provider.Settings
import android.speech.RecognizerIntent
import java.io.File
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

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

    /** Paints the strokes onto a copy of the image and resolves with the copy's file URI. */
    AsyncFunction("annotateImage") { uri: String, strokes: List<AnnotationStroke> ->
      val context = appContext.reactContext
        ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready.", null)
      val source = Uri.parse(uri).path
        ?: throw CodedException("ERR_BAD_URI", "The image is not a file.", null)
      val bitmap = BitmapFactory.decodeFile(source)?.copy(Bitmap.Config.ARGB_8888, true)
        ?: throw CodedException("ERR_BAD_IMAGE", "The image could not be read.", null)
      val canvas = Canvas(bitmap)
      for (stroke in strokes) {
        if (stroke.points.size < 2) continue
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
          style = Paint.Style.STROKE
          strokeCap = Paint.Cap.ROUND
          strokeJoin = Paint.Join.ROUND
          strokeWidth = (stroke.width * bitmap.width).toFloat()
          color = Color.parseColor(stroke.color)
        }
        val path = Path()
        // Points are fractions of the image size, so they do not depend on the panel layout.
        stroke.points.chunked(2).forEachIndexed { index, point ->
          if (point.size < 2) return@forEachIndexed
          val x = (point[0] * bitmap.width).toFloat()
          val y = (point[1] * bitmap.height).toFloat()
          if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        canvas.drawPath(path, paint)
      }
      val file = File(
        AssistantCapture.screenshotDirectory(context),
        "annotated-${System.currentTimeMillis()}.jpg",
      )
      file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, ANNOTATED_QUALITY, it) }
      bitmap.recycle()
      Uri.fromFile(file).toString()
    }

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
    "selectedText" to selectedText,
    "screenshotUri" to screenshotUri,
    "screenshotWidth" to screenshotWidth,
    "screenshotHeight" to screenshotHeight,
  )

  private companion object {
    const val CAPTURE_EVENT = "onCapture"
    const val SPEECH_REQUEST_CODE = 0x7433
    const val ANNOTATED_QUALITY = 90
  }
}

/** One annotation stroke. Points are flat x, y pairs and the width is a fraction of the image width. */
class AnnotationStroke : Record {
  @Field val points: List<Double> = emptyList()
  @Field val width: Double = 0.006
  @Field val color: String = "#FF3B30"
}
