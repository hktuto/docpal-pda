package com.docpal.warehousepda.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * Runs [action] on every ON_RESUME, including the first one when the screen is composed
 * (a new observer is synced to the current lifecycle state). Native analogue of the web's
 * `useVisibleReload(load)` — use it instead of a ViewModel `init` load to avoid double loads.
 */
@Composable
fun OnResumeEffect(action: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentAction by rememberUpdatedState(action)
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) currentAction()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
}
