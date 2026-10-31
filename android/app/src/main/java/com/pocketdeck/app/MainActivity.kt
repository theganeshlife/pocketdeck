package com.pocketdeck.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Surface
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.util.Locale

/**
 * PocketDeck companion: a full-screen, always-awake WebView that hosts the bundled deck UI
 * (assets/www, copied from ../companion at build time) and talks to the PC over Wi-Fi.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var pageReady = false
    private var pendingDeepLink: String? = null

    @Volatile private var discovering = false
    private var discoveryThread: Thread? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var pendingCameraRequest: PermissionRequest? = null

    @Suppress("DEPRECATION")
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashCatcher()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0A0C11"))
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.isHapticFeedbackEnabled = false
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Least privilege: the bundled page needs no file, content or cross-origin access.
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            saveFormData = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            textZoom = 100
            setSupportZoom(false)
        }
        web.webChromeClient = object : WebChromeClient() {
            // The page may use only the camera, only from the bundled app, only for the QR scanner.
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val ours = request.origin?.toString().orEmpty().startsWith("file://")
                    val cameraOnly = request.resources.all { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }
                    if (!ours || !cameraOnly) {
                        request.deny()
                    } else if (checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingCameraRequest?.deny()
                        pendingCameraRequest = request
                        requestPermissions(arrayOf(android.Manifest.permission.CAMERA), CAMERA_REQUEST)
                    }
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Keep the deck in the app; web links (momo, feedback) open in the phone's browser.
                val url = request.url.toString()
                if (url.startsWith("file:///android_asset/")) return false
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (ignored: Exception) {
                    }
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingDeepLink?.let { sendDeepLink(it) }
                pendingDeepLink = null
            }
        }
        web.addJavascriptInterface(Bridge(), "PocketDeckNative")
        setContentView(web)
        web.loadUrl("file:///android_asset/www/index.html")

        handleIntent(intent)
        registerBackCallback()
        hideSystemBars()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != CAMERA_REQUEST) return
        val request = pendingCameraRequest ?: return
        pendingCameraRequest = null
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
        }
    }

    /** Back button (Android 12 and older): see handleBack(). */
    @Suppress("DEPRECATION")
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        handleBack()
    }

    /** Android 13 and newer send the back gesture here instead of onBackPressed(). */
    private fun registerBackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT
            ) { handleBack() }
        }
    }

    /** The page closes open panels first and may ask for a rating before the app closes. */
    private fun handleBack() {
        if (!pageReady) {
            finish()
            return
        }
        web.evaluateJavascript("window.__pdBack ? window.__pdBack() : 'exit'") { result ->
            if (result == null || result.contains("exit")) finish()
        }
    }

    /** Keeps the details of a crash on this device so the app can offer to send a report next time it opens. */
    private fun installCrashCatcher() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val trace = android.util.Log.getStackTraceString(error).take(4000)
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_CRASH, "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})\n$trace")
                    .commit()
            } catch (ignored: Exception) {
            }
            previous?.uncaughtException(thread, error)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** pocketdeck://pair?host=192.168.1.20:8765&pin=123456 */
    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "pocketdeck") return
        val host = data.getQueryParameter("host") ?: return
        val pin = data.getQueryParameter("pin") ?: data.getQueryParameter("pair") ?: ""
        val query = "host=" + java.net.URLEncoder.encode(host, "UTF-8") + "&pair=" + java.net.URLEncoder.encode(pin, "UTF-8")
        if (pageReady) sendDeepLink(query) else pendingDeepLink = query
    }

    private fun sendDeepLink(query: String) {
        web.evaluateJavascript("window.__pdDeepLink && window.__pdDeepLink(${JSONObject.quote(query)})", null)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        hideSystemBars()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        stopDiscovery()
        web.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN)
        }
    }

    // ------------------------------------------------------------------ LAN discovery
    private fun startDiscovery() {
        if (discovering) return
        discovering = true
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("pocketdeck").apply {
            setReferenceCounted(false)
            acquire()
        }
        discoveryThread = Thread {
            try {
                DatagramSocket(null).use { socket ->
                    socket.reuseAddress = true
                    socket.broadcast = true
                    socket.soTimeout = 1000
                    socket.bind(InetSocketAddress(DISCOVERY_PORT))
                    val buf = ByteArray(2048)
                    while (discovering) {
                        val packet = DatagramPacket(buf, buf.size)
                        try {
                            socket.receive(packet)
                        } catch (timeout: SocketTimeoutException) {
                            continue
                        }
                        val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                        try {
                            val json = JSONObject(text)
                            if (json.optString("app") == "pocketdeck") {
                                json.put("ip", packet.address.hostAddress)
                                val payload = JSONObject.quote(json.toString())
                                runOnUiThread {
                                    web.evaluateJavascript("window.__pdDiscovered && window.__pdDiscovered($payload)", null)
                                }
                            }
                        } catch (ignored: Exception) {
                            // not one of ours
                        }
                    }
                }
            } catch (ignored: Exception) {
                // network unavailable; manual address entry still works
            }
        }.apply { isDaemon = true; start() }
    }

    private fun stopDiscovery() {
        discovering = false
        discoveryThread = null
        try { multicastLock?.release() } catch (ignored: Exception) {}
        multicastLock = null
    }

    // ------------------------------------------------------------------ orientation
    /** The fixed orientation matching how the phone is held right now (works for phones and tablets). */
    @Suppress("DEPRECATION")
    private fun currentOrientationConstant(): Int {
        val rotation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: Surface.ROTATION_0
        } else {
            windowManager.defaultDisplay.rotation
        }
        val portrait = resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        return when (rotation) {
            Surface.ROTATION_90 -> if (portrait) ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            Surface.ROTATION_180 -> if (portrait) ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
            Surface.ROTATION_270 -> if (portrait) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
            else -> if (portrait) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
    }

    private val allowedLocks = setOf(
        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
        ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
        ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT,
        ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE,
    )

    // ------------------------------------------------------------------ JS bridge
    inner class Bridge {
        @Suppress("DEPRECATION")
        @JavascriptInterface
        fun vibrate(ms: Int) {
            val duration = ms.coerceIn(1, 200).toLong()
            val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
            } else {
                getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            vibrator?.vibrate(VibrationEffect.createOneShot(duration, if (duration < 30) 120 else VibrationEffect.DEFAULT_AMPLITUDE))
        }

        @Suppress("DEPRECATION")
        @JavascriptInterface
        fun getAppVersion(): String {
            return try {
                packageManager.getPackageInfo(packageName, 0).versionName ?: ""
            } catch (ignored: Exception) {
                ""
            }
        }

        @JavascriptInterface
        fun getDeviceName(): String {
            val maker = Build.MANUFACTURER.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString() }
            val model = Build.MODEL
            return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
        }

        /** mode: "portrait" (connect screen), "free" (any of the four directions) or "locked" (value = orientation). */
        @JavascriptInterface
        fun setOrientation(mode: String, value: Int) = runOnUiThread {
            requestedOrientation = when (mode) {
                "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                "locked" -> if (value in allowedLocks) value else ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
                else -> ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
            }
        }

        /** Locks to the current direction and returns it so the page can remember it. */
        @JavascriptInterface
        fun lockOrientation(): Int {
            val o = currentOrientationConstant()
            runOnUiThread { requestedOrientation = o }
            return o
        }

        @JavascriptInterface
        fun startDiscovery() = runOnUiThread { this@MainActivity.startDiscovery() }

        @JavascriptInterface
        fun stopDiscovery() = runOnUiThread { this@MainActivity.stopDiscovery() }

        /** Returns (and forgets) details of the last crash, if any. */
        @JavascriptInterface
        fun getPendingCrash(): String {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val crash = prefs.getString(KEY_CRASH, null) ?: return ""
            prefs.edit().remove(KEY_CRASH).apply()
            return crash
        }

        @JavascriptInterface
        fun exitApp() = runOnUiThread { finish() }

        @JavascriptInterface
        fun setTheme(background: String, dark: Boolean) = runOnUiThread {
            try {
                val c = Color.parseColor(background)
                window.decorView.setBackgroundColor(c)
                web.setBackgroundColor(c)
            } catch (ignored: Exception) {}
        }
    }

    companion object {
        const val DISCOVERY_PORT = 47800
        const val CAMERA_REQUEST = 42
        const val PREFS = "pocketdeck"
        const val KEY_CRASH = "pendingCrash"
    }
}
