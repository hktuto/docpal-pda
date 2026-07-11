package com.docpal.warehousepda.ui

import android.content.Context

object LocaleManager {
    const val DEFAULT_LOCALE = "zh-HK"
    val SUPPORTED = listOf("en-US", "zh-CN", "zh-HK")

    private const val PREFS = "locale_prefs"
    private const val KEY = "locale"

    fun currentLocale(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY, DEFAULT_LOCALE) ?: DEFAULT_LOCALE

    fun setLocale(context: Context, tag: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, tag)
            .apply()
    }
}
