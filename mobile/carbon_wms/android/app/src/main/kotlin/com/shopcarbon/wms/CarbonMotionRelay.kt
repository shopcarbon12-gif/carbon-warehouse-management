package com.shopcarbon.wms

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel

/**
 * Streams the handheld's yaw — rotation about the world's vertical axis — to
 * Flutter as degrees, for Locate-Tag's direction finding.
 *
 * ## Sensor choice
 *
 * `TYPE_GAME_ROTATION_VECTOR` is gyroscope + accelerometer with the
 * magnetometer deliberately left out. That matters here: a compass inside
 * steel racking, sitting next to a transmitting UHF radio, is not something to
 * navigate by. Direction finding only ever compares two headings taken seconds
 * apart during one sweep, so absolute north is irrelevant and the game rotation
 * vector's slow yaw drift never gets a chance to matter.
 *
 * Falls back to `TYPE_ROTATION_VECTOR` (which does fuse the magnetometer) only
 * on devices with no game vector at all, since a drifting heading still beats
 * no heading.
 *
 * Going through the rotation matrix — rather than integrating raw gyro axes,
 * whose meaning changes the moment the handheld is tipped — is what keeps the
 * heading meaningful however the operator holds the gun. See [headingDegrees]
 * for which axis is read out of that matrix and why it is not the obvious one.
 *
 * The sled is clamped to the phone, so the phone's yaw IS the gun's yaw.
 *
 * Lifecycle: the sensor is registered on the first Flutter listener and
 * unregistered the moment that listener goes away, so nothing is running while
 * the operator is on any other screen.
 */
class CarbonMotionRelay(
  private val context: Context,
) : EventChannel.StreamHandler, SensorEventListener {

  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile private var sink: EventChannel.EventSink? = null
  private var sensorManager: SensorManager? = null
  @Volatile private var warnedNoSensor = false
  private var emitted = 0

  private val rotationMatrix = FloatArray(9)
  // TYPE_GAME_ROTATION_VECTOR reports THREE values on some devices and four on
  // others, and TYPE_ROTATION_VECTOR sometimes reports five.
  // getRotationMatrixFromVector treats a length-4 array as "w is supplied" and
  // reads element 3 — so always handing it a 4-array meant that on a
  // three-value device it used an element the sensor never wrote (0.0) as the
  // quaternion's w, producing a garbage matrix and therefore a garbage heading.
  // Keep one buffer per real length and copy into the matching one.
  private val vector3 = FloatArray(3)
  private val vector4 = FloatArray(4)
  private var lastEmitNs = 0L

  override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
    sink = events
    val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    if (sm == null) {
      Log.w(TAG, "no SensorManager — direction finding unavailable")
      return
    }
    sensorManager = sm
    val sensor = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
      ?: sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    if (sensor == null) {
      warnedNoSensor = true
      Log.w(TAG, "no rotation-vector sensor on this device — direction finding unavailable")
      return
    }
    warnedNoSensor = false
    emitted = 0
    // SENSOR_DELAY_GAME is ~50 Hz, which is far more than a hand sweep needs;
    // onSensorChanged throttles further before crossing into Dart.
    sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
    Log.d(TAG, "yaw stream started on ${sensor.name}")
  }

  override fun onCancel(arguments: Any?) = stop()

  fun dispose() = stop()

  private fun stop() {
    sensorManager?.let {
      runCatching { it.unregisterListener(this) }
    }
    sensorManager = null
    sink = null
    lastEmitNs = 0L
    Log.d(TAG, "yaw stream stopped")
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { /* not used */ }

  /**
   * Compass heading of the direction the gun is POINTING, in degrees.
   *
   * `getOrientation()[0]` (azimuth) is the obvious call and the wrong one here.
   * Azimuth describes where the phone's Y axis — its top edge — points, once
   * projected onto the horizontal plane. In an RFD8500 cradle the phone stands
   * roughly upright facing the operator, so Y points nearly straight UP: its
   * horizontal projection is tiny and the azimuth derived from it is numerically
   * unstable exactly in the geometry we care about. That alone can make the
   * heading useless noise while looking perfectly healthy.
   *
   * The barrel points out of the BACK of the screen, i.e. along the device's
   * -Z axis, which is close to horizontal in that same grip. So take -Z's
   * heading, and fall back to the Y axis only when -Z is too close to vertical
   * (the phone lying flat on a bench).
   *
   * The rotation matrix maps device coordinates to world (East, North, Up), so
   * device -Z lands at (-R[2], -R[5], -R[8]) and device Y at (R[1], R[4], R[7]).
   *
   * Only RELATIVE bearing is ever used, so whatever constant offset a given
   * mounting introduces cancels out. What matters is that this turns 1:1 with
   * the operator and stays well-conditioned while it does.
   */
  private fun headingDegrees(): Double {
    val east = -rotationMatrix[2]
    val north = -rotationMatrix[5]
    val horizontal = Math.hypot(east.toDouble(), north.toDouble())
    if (horizontal > 0.25) {
      return Math.toDegrees(Math.atan2(east.toDouble(), north.toDouble()))
    }
    return Math.toDegrees(
      Math.atan2(rotationMatrix[1].toDouble(), rotationMatrix[4].toDouble()),
    )
  }

  override fun onSensorChanged(event: SensorEvent?) {
    val e = event ?: return
    val s = sink ?: return
    // Throttle to ~50 Hz. The bearing estimator bins at 10°, so anything
    // faster is pure overhead on the platform channel.
    if (lastEmitNs != 0L && e.timestamp - lastEmitNs < 20_000_000L) return
    lastEmitNs = e.timestamp

    val src = if (e.values.size >= 4) vector4 else vector3
    System.arraycopy(e.values, 0, src, 0, src.size)

    val yawDeg = try {
      SensorManager.getRotationMatrixFromVector(rotationMatrix, src)
      headingDegrees()
    } catch (t: Throwable) {
      Log.w(TAG, "rotation vector conversion failed: ${t.message}")
      return
    }

    if (!warnedNoSensor && emitted < 3) {
      emitted++
      Log.d(TAG, "yaw sample #$emitted = ${"%.1f".format(yawDeg)}")
    }
    mainHandler.post { s.success(yawDeg) }
  }

  private companion object {
    const val TAG = "CarbonMotion"
  }
}
