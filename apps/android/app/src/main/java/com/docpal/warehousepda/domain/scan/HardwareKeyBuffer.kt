package com.docpal.warehousepda.domain.scan

/**
 * Hardware scanner wedge buffering — port of useHardwareScanner.ts.
 * Scanners type the code as keystrokes and finish with Enter; a 300 ms idle
 * gap clears partial input. Returns CONSUMED so the caller can eat the key
 * event (web preventDefault).
 */
class HardwareKeyBuffer(
    private val clock: Clock,
    private val idleTimeoutMs: Long = 300,
    private val onFlush: (String) -> Unit,
) {
    interface Clock { fun nowMillis(): Long }

    enum class Consume { CONSUMED, IGNORED }

    var enabled: Boolean = true
    var pending: String = ""
        private set

    private var lastKeyAt: Long = 0

    fun onKey(key: String): Consume {
        if (!enabled) return Consume.IGNORED
        val now = clock.nowMillis()
        if (pending.isNotEmpty() && now - lastKeyAt > idleTimeoutMs) pending = ""
        if (key == "Enter") {
            if (pending.isEmpty()) return Consume.IGNORED
            val value = pending
            pending = ""
            onFlush(value)
            return Consume.CONSUMED
        }
        if (key.length != 1) return Consume.IGNORED   // printable single chars only
        lastKeyAt = now
        pending += key
        return Consume.CONSUMED
    }
}
