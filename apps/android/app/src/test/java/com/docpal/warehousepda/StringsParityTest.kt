package com.docpal.warehousepda

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.Locale

/**
 * Guards string-resource parity across locales: every R.string entry must
 * resolve to a non-empty value in every supported locale (en-US default,
 * zh-rCN, zh-HK) without throwing, and every locale's strings.xml must
 * declare exactly the same set of keys (Android silently falls back to
 * the default values/ for missing keys, so resolution alone cannot catch
 * a missing translation).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StringsParityTest {

    private val locales = listOf(
        Locale.US, // default values/
        Locale("zh", "CN"), // values-zh-rCN/
        Locale("zh", "HK") // values-zh-rHK/
    )

    private val localeDirs = mapOf(
        "en-US" to "values",
        "zh-rCN" to "values-zh-rCN",
        "zh-HK" to "values-zh-rHK"
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

    @Test
    fun `string key sets are identical across locale files`() {
        val namePattern = Regex("""<string\s+name="([^"]+)"""")
        val keySets = localeDirs.mapValues { (locale, dir) ->
            // Unit-test working dir is the app module dir; tolerate a
            // repo-root working dir as well.
            val file = listOf(
                File("src/main/res/$dir/strings.xml"),
                File("app/src/main/res/$dir/strings.xml")
            ).firstOrNull { it.isFile }
            assertTrue("Missing strings.xml for $locale", file != null)
            namePattern.findAll(file!!.readText()).map { it.groupValues[1] }.toSet()
        }

        val base = keySets.getValue("en-US")
        for ((locale, keys) in keySets) {
            assertEquals(
                "Key set mismatch for $locale vs en-US " +
                    "(missing: ${base - keys}, extra: ${keys - base})",
                base,
                keys
            )
        }
    }
}
