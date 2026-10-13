package com.shopcarbon.gradingai.ar

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import java.io.ByteArrayOutputStream

/** Camera image (YUV_420_888) copied out of ARCore, so the Image can be closed at once. */
class YuvFrame(val w: Int, val h: Int, val nv21: ByteArray) {
    fun toBitmap(quality: Int = 96): Bitmap {
        val out = ByteArrayOutputStream()
        YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), quality, out)
        val bytes = out.toByteArray()
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inMutable = false })
    }

    /** Small RGB copy for the live coverage check (nearest-neighbour, every `step` pixels). */
    fun preview(step: Int): Bitmap {
        val pw = w / step; val ph = h / step
        val px = IntArray(pw * ph)
        val uvStart = w * h
        for (y in 0 until ph) for (x in 0 until pw) {
            val sx = x * step; val sy = y * step
            val yy = (nv21[sy * w + sx].toInt() and 0xff) - 16
            val uvi = uvStart + (sy shr 1) * w + (sx and 1.inv())
            val v = (nv21[uvi].toInt() and 0xff) - 128
            val u = (nv21[uvi + 1].toInt() and 0xff) - 128
            val c = 1.164f * yy
            val r = (c + 1.596f * v).toInt().coerceIn(0, 255)
            val g = (c - 0.392f * u - 0.813f * v).toInt().coerceIn(0, 255)
            val b = (c + 2.017f * u).toInt().coerceIn(0, 255)
            px[y * pw + x] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }
        return Bitmap.createBitmap(px, pw, ph, Bitmap.Config.ARGB_8888)
    }

    companion object {
        fun copy(img: Image): YuvFrame {
            val w = img.width; val h = img.height
            val out = ByteArray(w * h * 3 / 2)
            val yP = img.planes[0]; val uP = img.planes[1]; val vP = img.planes[2]
            val yBuf = yP.buffer; val yRow = yP.rowStride; val yPix = yP.pixelStride
            var o = 0
            for (r in 0 until h) {
                if (yPix == 1) {
                    yBuf.position(r * yRow)
                    yBuf.get(out, o, w)
                    o += w
                } else {
                    for (c in 0 until w) out[o++] = yBuf.get(r * yRow + c * yPix)
                }
            }
            val uBuf = uP.buffer; val vBuf = vP.buffer
            val uRow = uP.rowStride; val uPix = uP.pixelStride
            val vRow = vP.rowStride; val vPix = vP.pixelStride
            for (r in 0 until h / 2) for (c in 0 until w / 2) {
                out[o++] = vBuf.get(r * vRow + c * vPix)
                out[o++] = uBuf.get(r * uRow + c * uPix)
            }
            return YuvFrame(w, h, out)
        }
    }
}
