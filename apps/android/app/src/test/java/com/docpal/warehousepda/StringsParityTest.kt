package com.docpal.warehousepda

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

/**
 * Guards string-resource parity across locales: every R.string entry must
 * resolve to a non-empty value in every supported locale (en-US default,
 * zh-rCN, zh-HK) without throwing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StringsParityTest {

    private val locales = listOf(
        Locale.US, // default values/
        Locale("zh", "CN"), // values-zh-rCN/
        Locale("zh", "HK") // values-zh-rHK/
    )

    @Test
    fun `every string resolves non-empty in every locale`() {
        val baseContext = ApplicationProvider.getApplicationContext<Context>()
        val stringNames = R.string::class.java.declaredFields
            .filter { it.type == Int::class.javaPrimitiveType }
            .map { it.name }

        assertTrue("R.string should not be empty", stringNames.isNotEmpty())

        for (locale in locales) {
            val config = Configuration(baseContext.resources.configuration)
            config.setLocale(locale)
            val context = baseContext.createConfigurationContext(config)
            for (name in stringNames) {
                val id = R.string::class.java.getField(name).getInt(null)
                val value = context.resources.getString(id)
                assertTrue(
                    "String $name is empty for locale $locale",
                    value.isNotEmpty()
                )
            }
        }
    }
}
