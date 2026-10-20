package expo.modules.t3assistant

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.File
import java.lang.ref.WeakReference

/**
 * The screen context of the latest assistant press. The session writes it while the system
 * delivers the screen text and the screenshot; the panel reads it and listens for changes.
 */
object AssistantCapture {
  data class Snapshot(
    val id: Long,
    val sourcePackage: String?,
    val webUri: String?,
    val screenText: String?,
    /** Text that was selected in the app on screen, if any. */
    val selectedText: String?,
    val screenshotUri: String?,
    val screenshotWidth: Int,
    val screenshotHeight: Int,
  )

  private val main = Handler(Looper.getMainLooper())
  private var session: WeakReference<AssistantSession>? = null

  @Volatile
  var current: Snapshot? = null
    private set

  /** Set by the JS module while a panel listens. Called on the main thread. */
  var listener: ((Snapshot) -> Unit)? = null

  fun begin(context: Context, owner: AssistantSession) {
    session = WeakReference(owner)
    screenshotDirectory(context).listFiles()?.forEach { it.delete() }
    publish(Snapshot(System.currentTimeMillis(), null, null, null, null, null, 0, 0))
  }

  fun addScreen(
    sourcePackage: String?,
    webUri: String?,
    screenText: String?,
    selectedText: String?,
  ) = update {
    it.copy(
      sourcePackage = it.sourcePackage ?: sourcePackage,
      webUri = it.webUri ?: webUri,
      selectedText = it.selectedText ?: selectedText,
      screenText = listOfNotNull(it.screenText, screenText?.takeIf(String::isNotBlank))
        .joinToString("\n\n")
        .ifEmpty { null },
    )
  }

  fun setScreenshot(uri: String, width: Int, height: Int) = update {
    it.copy(screenshotUri = uri, screenshotWidth = width, screenshotHeight = height)
  }

  /** The panel closed, so the session has nothing left to show. */
  fun panelClosed() {
    session?.get()?.finish()
    session = null
  }

  fun screenshotDirectory(context: Context) = File(context.cacheDir, "t3-assistant").apply { mkdirs() }

  private fun update(change: (Snapshot) -> Snapshot) {
    main.post { current?.let { publish(change(it)) } }
  }

  private fun publish(snapshot: Snapshot) {
    current = snapshot
    listener?.invoke(snapshot)
  }
}
