package com.docpal.warehousepda.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R

/**
 * Status color families, ported from the web `useStatusBadge.badgeClass`.
 * Labels resolve via [statusLabelRes] with the `status_<family>_<code>` string keys,
 * mirroring the web `useStatusLabel`.
 */
@Composable
fun StatusBadge(status: String, family: String = "receiving", modifier: Modifier = Modifier) {
    val s = status.lowercase().replace('_', '-')
    val color = when (s) {
        "pending", "open" -> Color(0xFFF59E0B)
        "in-hand", "picking" -> Color(0xFF3B82F6)
        "finished", "completed", "verified", "closed", "clear", "done" -> Color(0xFF10B981)
        "issue", "danger" -> Color(0xFFEF4444)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val labelRes = statusLabelRes(family, status)
    Text(
        text = labelRes?.let { stringResource(it) } ?: status,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        modifier = modifier
            .clip(RoundedCornerShape(9999.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/** Maps (family, status code) to the `status_<family>_<code>` string resource; null when unknown. */
fun statusLabelRes(family: String, status: String): Int? = when (family) {
    "receiving" -> when (status) {
        "pending" -> R.string.status_receiving_pending
        "in_hand" -> R.string.status_receiving_in_hand
        "clear" -> R.string.status_receiving_clear
        else -> null
    }
    "picking" -> when (status) {
        "pending" -> R.string.status_picking_pending
        "picking" -> R.string.status_picking_picking
        "finished" -> R.string.status_picking_finished
        "issue" -> R.string.status_picking_issue
        else -> null
    }
    "box" -> when (status) {
        "open" -> R.string.status_box_open
        "closed" -> R.string.status_box_closed
        "verified" -> R.string.status_box_verified
        else -> null
    }
    "measuring" -> when (status) {
        "pending" -> R.string.status_measuring_pending
        "completed" -> R.string.status_measuring_completed
        else -> null
    }
    else -> null
}
