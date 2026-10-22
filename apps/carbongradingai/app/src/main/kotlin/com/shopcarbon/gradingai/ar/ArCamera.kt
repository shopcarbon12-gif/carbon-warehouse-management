package com.shopcarbon.gradingai.ar

import android.app.Activity
import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Frame
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import java.nio.ByteOrder
import java.util.EnumSet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.acos
import kotlin.math.max
import kotlin.math.sqrt

/** What the viewfinder knows right now (posted to the main thread a few times a second). */
data class LiveStatus(
    val tracking: Boolean,
    val tof: Boolean,
    val plane: Plane?,
    val still: Boolean,
    /** null until the first coverage check; empty = the whole garment is in the frame. */
    val cutOff: Set<String>?,
    val garmentFound: Boolean,
    val depthAgeMs: Long,
)

/** Everything one capture needs, copied out of ARCore on the GL thread. */
class CaptureBundle(
    val yuv: YuvFrame,
    val depth: DepthSnapshot?,
    val fx: Float, val fy: Float, val cx: Float, val cy: Float,
    val sensorOrientation: Int,
    val tof: Boolean,
    val livePlane: Plane?,
    val capturedAtMs: Long,
    /** Depth image age against the photo's own ARCore frame (ms). */
    val depthAgeMs: Double,
    /** Share of depth pixels at the confidence the measurement uses (0–1). */
    val highConfFrac: Double,
)

/**
 * The ARCore session behind the capture screen: the live camera picture, the
 * raw depth from the time-of-flight sensor (Note10+, Note10+ 5G, S20+, S20
 * Ultra), a table-plane fit a few times a second for the distance / level
 * checks, and the capture itself.
 */
class ArCamera(
    private val activity: Activity,
    /** false only in test mode: then ARCore's depth-from-motion stands in for the sensor. */
    private val requireTof: Boolean,
    private val coverage: (android.graphics.Bitmap) -> Set<String>?,
    private val onLive: (LiveStatus) -> Unit,
    private val onCaptured: (CaptureBundle) -> Unit,
    private val onFailure: (String) -> Unit,
    /** No fresh depth frame came in time for a requested photo (the screen re-arms). */
    private val onDepthTimeout: (String) -> Unit = onFailure,
    /** Where the camera picture sits on the view (left, top, width, height in px), so the screen can frame exactly what the photo holds. */
    private val onPreview: (IntArray) -> Unit = {},
) : GLSurfaceView.Renderer {
    companion object {
        /** Depth may be at most this much older than the camera frame it is measured with. */
        const val MAX_DEPTH_AGE_MS = 100.0
        /** How long a requested photo waits for fresh depth before saying so. */
        const val DEPTH_WAIT_MS = 1000L
    }

    val view: GLSurfaceView = GLSurfaceView(activity).apply {
        preserveEGLContextOnPause = true
        setEGLContextClientVersion(2)
        setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        setRenderer(this@ArCamera)
        renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val coverageWorker = Executors.newSingleThreadExecutor()
    private val bg = BackgroundRenderer()
    private var session: Session? = null
    private var textureSet = false
    private var viewW = 0
    private var viewH = 0
    private var geometryDirty = true
    var tof = false
        private set
    var sensorOrientation = 90
        private set
    var imageSize: Pair<Int, Int> = 0 to 0
    private var textureSize: Pair<Int, Int> = 0 to 0
    /* The camera picture, fitted (not cropped) into the view: the whole field the
       photo holds is on screen, with black bars where the shapes differ. Filling
       the tall screen instead cut 15–40% off the sides, so a garment looked cut off
       while the photo had room (owner, 2026-10-21: "hard to get the item in the frame"). */
    private var fitX = 0; private var fitY = 0; private var fitW = 0; private var fitH = 0
        private set

    private val captureRequested = AtomicBoolean(false)
    private val analyzing = AtomicBoolean(false)
    private val checkingCoverage = AtomicBoolean(false)
    private var lastDepthAt = 0L
    private var lastCoverageAt = 0L
    @Volatile private var plane: Plane? = null
    @Volatile private var planeAt = 0L
    @Volatile private var cutOff: Set<String>? = null
    /** Set when a capture is asked for; the photo waits for a fresh depth frame. */
    private var pendingSince = 0L
    private val poses = ArrayDeque<Triple<Long, FloatArray, FloatArray>>()

    /** Create (once) and resume the session. Returns a reason when the phone cannot measure. */
    fun resume(): String? {
        try {
            if (session == null) {
                val s = Session(activity)
                val back = CameraConfigFilter(s).setFacingDirection(CameraConfig.FacingDirection.BACK)
                val withTof = s.getSupportedCameraConfigs(
                    CameraConfigFilter(s).setFacingDirection(CameraConfig.FacingDirection.BACK)
                        .setDepthSensorUsage(EnumSet.of(CameraConfig.DepthSensorUsage.REQUIRE_AND_USE)),
                )
                tof = withTof.isNotEmpty()
                if (!tof && requireTof) {
                    s.close()
                    return "This phone has no depth sensor ARCore can use. CarbonGradingAI measures on the Galaxy Note10+, Note10+ 5G, S20+ and S20 Ultra."
                }
                val configs = if (tof) withTof else s.getSupportedCameraConfigs(back)
                /* A config whose preview (GPU texture) has the photo's (CPU image's) shape
                   first, so the preview shows the same field as the photo; then the
                   largest CPU image: every extra pixel is resolution on the garment's edges. */
                fun aspect(w: Int, h: Int) = w.toDouble() / h
                val best = configs.maxWithOrNull(
                    compareBy<CameraConfig> { kotlin.math.abs(aspect(it.textureSize.width, it.textureSize.height) - aspect(it.imageSize.width, it.imageSize.height)) < 0.02 }
                        .thenBy { it.imageSize.width.toLong() * it.imageSize.height },
                ) ?: configs.first()
                textureSize = best.textureSize.width to best.textureSize.height
                s.cameraConfig = best
                imageSize = best.imageSize.width to best.imageSize.height
                sensorOrientation = runCatching {
                    (activity.getSystemService(Context.CAMERA_SERVICE) as CameraManager)
                        .getCameraCharacteristics(best.cameraId).get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
                }.getOrDefault(90)
                val cfg = Config(s).apply {
                    depthMode = when {
                        s.isDepthModeSupported(Config.DepthMode.RAW_DEPTH_ONLY) -> Config.DepthMode.RAW_DEPTH_ONLY
                        s.isDepthModeSupported(Config.DepthMode.AUTOMATIC) -> Config.DepthMode.AUTOMATIC
                        else -> Config.DepthMode.DISABLED
                    }
                    focusMode = Config.FocusMode.AUTO
                    updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
                    planeFindingMode = Config.PlaneFindingMode.DISABLED
                    lightEstimationMode = Config.LightEstimationMode.DISABLED
                }
                if (cfg.depthMode == Config.DepthMode.DISABLED) {
                    s.close()
                    return "ARCore offers no depth on this phone, so it cannot measure."
                }
                s.configure(cfg)
                session = s
            }
            session!!.resume()
            geometryDirty = true
            view.onResume()
            return null
        } catch (e: Exception) {
            return "The camera could not start: ${e.message ?: e.javaClass.simpleName}"
        }
    }

    fun pause() {
        view.onPause()
        session?.pause()
    }

    fun close() {
        session?.close()
        session = null
        worker.shutdownNow()
        coverageWorker.shutdownNow()
    }

    fun requestCapture() = captureRequested.set(true)

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        bg.create()
        textureSet = false
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        viewW = width; viewH = height
        fitPreview()
        geometryDirty = true
    }

    private fun fitPreview() {
        val (tw, th) = textureSize
        // Portrait phone, landscape sensor: on screen the picture is th wide × tw tall.
        if (tw <= 0 || th <= 0 || viewW <= 0) { fitX = 0; fitY = 0; fitW = viewW; fitH = viewH }
        else {
            val portrait = th.toDouble() / tw
            if (viewW / portrait <= viewH) { fitW = viewW; fitH = (viewW / portrait).toInt() } else { fitH = viewH; fitW = (viewH * portrait).toInt() }
            fitX = (viewW - fitW) / 2; fitY = (viewH - fitH) / 2
        }
        val r = intArrayOf(fitX, fitY, fitW, fitH)
        main.post { onPreview(r) }
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val s = session ?: return
        if (!textureSet) { s.setCameraTextureName(bg.textureId); textureSet = true }
        if (geometryDirty && viewW > 0) { fitPreview(); s.setDisplayGeometry(Surface.ROTATION_0, fitW, fitH); geometryDirty = false }
        // GL's viewport origin is the bottom-left corner.
        GLES20.glViewport(fitX, viewH - fitY - fitH, fitW, fitH)
        val frame = try { s.update() } catch (e: Exception) {
            main.post { onFailure("Camera stopped: ${e.message ?: e.javaClass.simpleName}") }
            return
        }
        bg.draw(frame)
        val cam = frame.camera
        val tracking = cam.trackingState == TrackingState.TRACKING
        val now = SystemClock.uptimeMillis()
        if (tracking) trackStillness(now, cam.pose.translation, cam.pose.rotationQuaternion)

        if (captureRequested.getAndSet(false)) pendingSince = now
        if (pendingSince > 0) tryCapture(frame, now)

        if (tracking && now - lastDepthAt > 220 && !analyzing.get()) {
            lastDepthAt = now
            // Only fresh depth may move the live checks (an old frame reprojected forward must not keep them green).
            depthSnapshot(frame)?.takeIf { it.ageMs <= MAX_DEPTH_AGE_MS }?.let { snap ->
                analyzing.set(true)
                worker.execute {
                    try {
                        val p = PlaneFit.fit(snap.points(step = 2, minConf = minConf()))
                        if (p != null) { plane = p; planeAt = SystemClock.uptimeMillis() }
                    } finally { analyzing.set(false) }
                }
            }
        }
        if (now - lastCoverageAt > 900 && !checkingCoverage.get()) {
            lastCoverageAt = now
            runCatching {
                frame.acquireCameraImage().use { img ->
                    val yuv = YuvFrame.copy(img)
                    checkingCoverage.set(true)
                    coverageWorker.execute {
                        try {
                            val small = yuv.preview(max(1, yuv.w / 320))
                            cutOff = coverage(small)?.map { displayEdge(it) }?.toSet()
                        } catch (_: Exception) { } finally { checkingCoverage.set(false) }
                    }
                }
            }
        }
        val st = LiveStatus(
            tracking = tracking, tof = tof, plane = plane, still = isStill(now), cutOff = cutOff,
            garmentFound = cutOff != null, depthAgeMs = if (planeAt == 0L) Long.MAX_VALUE else now - planeAt,
        )
        main.post { onLive(st) }
    }

    private fun minConf() = if (tof) 128 else 64

    /**
     * Take the photo only with FRESH depth from the same ARCore frame: the
     * depth image at most [MAX_DEPTH_AGE_MS] older than the camera frame. No
     * cached snapshot. If none arrives within [DEPTH_WAIT_MS], give up with a
     * message (the screen re-arms auto-capture).
     */
    private fun tryCapture(frame: Frame, now: Long) {
        val depth = depthSnapshot(frame)
        if (depth == null || depth.ageMs > MAX_DEPTH_AGE_MS || depth.ageMs < -5) {
            if (now - pendingSince > DEPTH_WAIT_MS) {
                pendingSince = 0
                val why = if (depth == null) "no depth frame" else "depth ${depth.ageMs.toInt()} ms old"
                main.post { onDepthTimeout("Depth not ready ($why) — hold still, it will try again.") }
            }
            return
        }
        pendingSince = 0
        capture(frame, now, depth)
    }

    private fun capture(frame: Frame, now: Long, depth: DepthSnapshot) {
        try {
            val yuv = frame.acquireCameraImage().use { YuvFrame.copy(it) }
            val ii = frame.camera.imageIntrinsics
            val f = ii.focalLength; val c = ii.principalPoint; val dim = ii.imageDimensions
            // Intrinsics belong to the CPU image; scale if ARCore reports another size.
            val sx = yuv.w.toFloat() / dim[0]; val sy = yuv.h.toFloat() / dim[1]
            val b = CaptureBundle(yuv, depth, f[0] * sx, f[1] * sy, c[0] * sx, c[1] * sy, sensorOrientation, tof, plane, now,
                depthAgeMs = depth.ageMs, highConfFrac = depth.highConfFrac(minConf()))
            main.post { onCaptured(b) }
        } catch (e: Exception) {
            main.post { onFailure("Capture failed: ${e.message ?: e.javaClass.simpleName}") }
        }
    }

    private fun depthSnapshot(frame: Frame): DepthSnapshot? = try {
        frame.acquireRawDepthImage16Bits().use { d ->
            frame.acquireRawDepthConfidenceImage().use { cf ->
                val w = d.width; val h = d.height
                val mm = ShortArray(w * h)
                val dp = d.planes[0]
                val db = dp.buffer.order(ByteOrder.LITTLE_ENDIAN)
                for (y in 0 until h) for (x in 0 until w) mm[y * w + x] = db.getShort(y * dp.rowStride + x * dp.pixelStride)
                val conf = ByteArray(w * h)
                val cp = cf.planes[0]
                val cb = cp.buffer
                for (y in 0 until h) for (x in 0 until w) conf[y * w + x] = cb.get(y * cp.rowStride + x * cp.pixelStride)
                /* The official raw-depth sample scales the GPU texture's intrinsics to
                   the depth image; the depth image covers the same view as the texture. */
                val ti = frame.camera.textureIntrinsics
                val tf = ti.focalLength; val tc = ti.principalPoint; val td = ti.imageDimensions
                val kx = w.toFloat() / td[0]; val ky = h.toFloat() / td[1]
                val ageMs = (frame.timestamp - d.timestamp) / 1e6
                DepthSnapshot(w, h, mm, conf, tf[0] * kx, tf[1] * ky, tc[0] * kx, tc[1] * ky, ageMs)
            }
        }
    } catch (_: NotYetAvailableException) {
        null
    } catch (_: Exception) {
        null
    }

    /** Sensor edge → the edge as the operator sees it on the portrait screen. */
    private fun displayEdge(e: String): String {
        val order = listOf("top", "right", "bottom", "left")
        val i = order.indexOf(e)
        if (i < 0) return e
        return order[(i + sensorOrientation / 90) % 4]
    }

    private fun trackStillness(now: Long, t: FloatArray, q: FloatArray) {
        poses.addLast(Triple(now, t.copyOf(), q.copyOf()))
        while (poses.isNotEmpty() && now - poses.first().first > 1500) poses.removeFirst()
    }

    /**
     * Still = over the last 0.5 s the phone moved under 2 cm and turned under 2.5°.
     * Normal hand shake passes (owner, 2026-10-22: "we are not robots") — the photo
     * and its depth come from one frame, so a small sway does not blur the scale.
     */
    private fun isStill(now: Long): Boolean {
        val recent = poses.filter { now - it.first <= 500 }
        if (recent.size < 6) return false
        val a = recent.first(); val b = recent.last()
        val dx = a.second[0] - b.second[0]; val dy = a.second[1] - b.second[1]; val dz = a.second[2] - b.second[2]
        val moved = sqrt(dx * dx + dy * dy + dz * dz)
        val dot = (a.third[0] * b.third[0] + a.third[1] * b.third[1] + a.third[2] * b.third[2] + a.third[3] * b.third[3]).coerceIn(-1f, 1f)
        val turnedDeg = Math.toDegrees(2.0 * acos(kotlin.math.abs(dot).toDouble()))
        return moved < 0.02f && turnedDeg < 2.5
    }
}
