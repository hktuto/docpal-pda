package com.docpal.warehousepda.domain

/**
 * Kotlin equivalent of the web's I18nError — carries an i18n code the UI
 * maps to a string resource, plus optional interpolation params.
 */
class LocalizedException(
    val code: String,
    val params: Map<String, String> = emptyMap(),
) : Exception(code)
