package com.tms.terminal

import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)

    // Disable haptic/vibration feedback globally for all views in this activity.
    // Samsung One UI adds unwanted vibration when any input field receives focus.
    window.decorView.isHapticFeedbackEnabled = false
    window.decorView.rootView.isHapticFeedbackEnabled = false
  }

  override fun onContentChanged() {
    super.onContentChanged()
    // Also disable on content root (React Native replaces content dynamically)
    findViewById<View>(android.R.id.content)?.isHapticFeedbackEnabled = false
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  // ── Mouse wheel → horizontal scroll ────────────────────────────────────
  // Android's HorizontalScrollView ignores AXIS_VSCROLL from the mouse wheel.
  // We intercept it here and convert it to a horizontal scrollBy.
  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_SCROLL) {
      val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
      if (vScroll != 0f) {
        val target = findHorizontalScrollViewAt(
          window.decorView, event.rawX.toInt(), event.rawY.toInt()
        )
        if (target != null) {
          target.scrollBy((-vScroll * 120).toInt(), 0)
          return true
        }
      }
    }
    return super.dispatchGenericMotionEvent(event)
  }

  private fun findHorizontalScrollViewAt(view: View, x: Int, y: Int): HorizontalScrollView? {
    if (view is HorizontalScrollView) {
      val loc = IntArray(2)
      view.getLocationOnScreen(loc)
      if (x in loc[0]..(loc[0] + view.width) && y in loc[1]..(loc[1] + view.height)) {
        return view
      }
    }
    if (view is ViewGroup) {
      for (i in view.childCount - 1 downTo 0) {
        val result = findHorizontalScrollViewAt(view.getChildAt(i), x, y)
        if (result != null) return result
      }
    }
    return null
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
