package com.docpal.warehousepda.ui.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.docpal.warehousepda.R

/**
 * Resolves a `LocalizedException.code` to a display string: the `error_<code>` string
 * resource when it exists, falling back to the raw code. Shared by all screens so
 * error localization lives in one place.
 */
@Composable
fun errorMessage(key: String): String {
    val context = LocalContext.current
    val resId = remember(key) {
        when (key) {
            // Login's auth error predates the error_<code> naming scheme.
            "invalid_username_or_password" -> R.string.error_invalid_credentials
            else -> context.resources
                .getIdentifier("error_$key", "string", context.packageName)
                .takeIf { it != 0 }
        }
    }
    return resId?.let { stringResource(it) } ?: key
}

/** Red error text for a `LocalizedException.code`; renders nothing when [key] is null. */
@Composable
fun ErrorText(key: String?, modifier: Modifier = Modifier) {
    if (key == null) return
    Text(
        text = errorMessage(key),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = modifier,
    )
}
