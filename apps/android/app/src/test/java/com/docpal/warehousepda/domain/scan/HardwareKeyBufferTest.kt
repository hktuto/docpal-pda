package com.docpal.warehousepda.domain.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HardwareKeyBufferTest {

    private class FakeClock(var now: Long = 0) : HardwareKeyBuffer.Clock {
        override fun nowMillis() = now
    }

    @Test fun `printable keys accumulate, Enter flushes`() {
        val clock = FakeClock()
        val flushed = ArrayList<String>()
        val buffer = HardwareKeyBuffer(clock, idleTimeoutMs = 300, onFlush = flushed::add)
        assertEquals(HardwareKeyBuffer.Consume.CONSUMED, buffer.onKey("A"))
        assertEquals(HardwareKeyBuffer.Consume.CONSUMED, buffer.onKey("1"))
        assertEquals(HardwareKeyBuffer.Consume.CONSUMED, buffer.onKey("Enter"))
        assertEquals(listOf("A1"), flushed)
        assertEquals("", buffer.pending)
    }

    @Test fun `Enter with empty buffer is ignored (not consumed)`() {
        val buffer = HardwareKeyBuffer(FakeClock(), 300) {}
        assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey("Enter"))
    }

    @Test fun `non-printable keys are ignored`() {
        val buffer = HardwareKeyBuffer(FakeClock(), 300) {}
        for (key in listOf("Shift", "F1", "Control", "ArrowLeft")) {
            assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey(key))
        }
        assertEquals("", buffer.pending)
    }

    @Test fun `idle timeout clears the buffer`() {
        val clock = FakeClock()
        val buffer = HardwareKeyBuffer(clock, 300) {}
        buffer.onKey("A")
        clock.now += 299
        buffer.onKey("B")          // still within idle window
        assertEquals("AB", buffer.pending)
        clock.now += 301
        buffer.onKey("C")          // previous content expired
        assertEquals("C", buffer.pending)
    }

    @Test fun `disabled buffer ignores everything`() {
        val buffer = HardwareKeyBuffer(FakeClock(), 300) {}
        buffer.enabled = false
        assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey("A"))
        assertEquals(HardwareKeyBuffer.Consume.IGNORED, buffer.onKey("Enter"))
        assertEquals("", buffer.pending)
    }
}
