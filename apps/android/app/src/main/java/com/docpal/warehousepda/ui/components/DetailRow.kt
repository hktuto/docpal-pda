package com.docpal.warehousepda.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R

/** Label-above-value row for detail pages; null/blank values render `common_no_data`. */
@Composable
fun DetailRow(label: String, value: String?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value?.takeIf { it.isNotBlank() } ?: stringResource(R.string.common_no_data),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
