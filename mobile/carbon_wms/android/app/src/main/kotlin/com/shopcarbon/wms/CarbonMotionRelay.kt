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
 * `getOrientation` returns azimuth as rotation about the gravity axis, so the
 * value stays meaningful however the operator tilts the gun — which is the
 * whole reason for going through the rotation matrix rather than integrating
 * raw gyro axes, whose meaning changes the moment the handheld is tipped.
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

  private val rotationMatrix = FloatArray(9)
  private val orientation = FloatArray(3)
  // Some OEMs hand back a 5-element rotation vector; getRotationMatrixFromVector
  // historically threw on those. Copying the first four elements is the
  // long-standing workaround and is harmless on well-behaved devices.
  private val vector = FloatArray(4)
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
      Log.w(TAG, "no rotation-vector sensor on this device — direction finding unavailable")
      return
    }
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

  override fun onSensorChanged(event: SensorEvent?) {
    val e = event ?: return
    val s = sink ?: return
    // Throttle to ~50 Hz. The bearing estimator bins at 10°, so anything
    // faster is pure overhead on the platform channel.
    if (lastEmitNs != 0L && e.timestamp - lastEmitNs < 20_000_000L) return
    lastEmitNs = e.timestamp

    val n = minOf(e.values.size, vector.size)
    for (i in 0 until n) vector[i] = e.values[i]

    val yawDeg = try {
      SensorManager.getRotationMatrixFromVector(rotationMatrix, vector)
      SensorManager.getOrientation(rotationMatrix, orientation)
      Math.toDegrees(orientation[0].toDouble())
    } catch (t: Throwable) {
      Log.w(TAG, "rotation vector conversion failed: ${t.message}")
      return
    }

    mainHandler.post { s.success(yawDeg) }
  }

  private companion object {
    const val TAG = "CarbonMotion"
  }
}
