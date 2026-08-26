package com.shopcarbon.wmspc.web

import java.net.InetSocketAddress
import java.net.Socket

/** Raw ZPL to a Zebra over TCP 9100 (same transport as the handheld's lan_zpl_printer.dart). */
object ZplPrinter {
    fun send(host: String, port: Int, zpl: String): Pair<Boolean, String> = try {
        Socket().use { s ->
            s.connect(InetSocketAddress(host, port), 5000)
            s.soTimeout = 5000
            s.getOutputStream().apply {
                write(zpl.toByteArray(Charsets.UTF_8))
                flush()
            }
        }
        true to "Sent ${zpl.length} bytes to $host:$port"
    } catch (e: Exception) {
        false to (e.message ?: e.javaClass.simpleName)
    }
}
