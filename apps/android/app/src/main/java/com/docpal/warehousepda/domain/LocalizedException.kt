package com.docpal.warehousepda.domain

/**
 * Kotlin equivalent of the web's I18nError — carries an i18n code the UI
 * maps to a string resource.
 */
class LocalizedException(val code: String) : Exception(code)
