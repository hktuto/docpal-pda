package com.docpal.warehousepda.ui.putaway

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.PutAwayBoxDetail
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.StatusBadge
import com.docpal.warehousepda.ui.picking.CardDoneColor

/**
 * Shelf-boxes section — port of the web ShelfBoxesPanel.vue.
 * Rendered inside the detail screen's LazyColumn; collapsed by default.
 * New box opens the select-shelf dialog (web openNewBoxDialog); "Add all" is
 * confirm-guarded at the screen level (web window.confirm).
 */
internal fun LazyListScope.shelfBoxesSection(
    detail: PutAwayDetail,
    expanded: Boolean,
    expandedContents: Set<String>,
    actionInProgress: Boolean,
    // PutAwayDetailUiState.unboxedScanCount — the business rule lives in the VM state.
    unboxedCount: Int,
    onToggleExpanded: () -> Unit,
    onToggleContents: (boxId: String) -> Unit,
    onNewBox: () -> Unit,
    onAddAll: (boxId: String, unboxedCount: Int) -> Unit,
    onCloseBox: (boxId: String) -> Unit,
    onCancelBox: (boxId: String) -> Unit,
) {
    // Web actionable: the order can still take stock (clear is terminal).
    val actionable = detail.header.status != "clear"
    item(key = "boxes-header") {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.put_away_boxes_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (actionable) {
                    OutlinedButton(onClick = onNewBox, enabled = !actionInProgress) {
                        Text(stringResource(R.string.put_away_new_box))
                    }
                }
                TextButton(onClick = onToggleExpanded) {
                    Text(
                        stringResource(
                            if (expanded) R.string.picking_boxes_hide
                            else R.string.picking_boxes_show
                        )
                    )
                }
            }
        }
    }
    if (!expanded) return
    if (detail.boxes.isEmpty()) {
        item { EmptyState(stringResource(R.string.common_no_boxes)) }
        return
    }
    // Group by shelf, preserving the DAO order within groups (LinkedHashMap keeps
    // first-seen group order, matching the web's boxesByShelf object build).
    val groups = LinkedHashMap<String?, MutableList<PutAwayBoxDetail>>()
    for (box in detail.boxes) groups.getOrPut(box.shelfCode) { mutableListOf() } += box
    for ((shelfCode, boxes) in groups) {
        item(key = "shelf-group-${shelfCode ?: "unassigned"}") {
            Text(
                when {
                    shelfCode == null -> stringResource(R.string.common_unassigned)
                    boxes.first().zone != null ->
                        stringResource(R.string.common_shelf_format, shelfCode, boxes.first().zone!!)
                    else -> shelfCode
                },
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        items(boxes, key = { it.id }) { box ->
            ShelfBoxCard(
                box = box,
                unboxedCount = unboxedCount,
                contentsExpanded = box.id in expandedContents,
                actionInProgress = actionInProgress,
                onToggleContents = { onToggleContents(box.id) },
                onAddAll = { onAddAll(box.id, unboxedCount) },
                onCloseBox = { onCloseBox(box.id) },
                onCancelBox = { onCancelBox(box.id) },
            )
        }
    }
}

@Composable
private fun ShelfBoxCard(
    box: PutAwayBoxDetail,
    unboxedCount: Int,
    contentsExpanded: Boolean,
    actionInProgress: Boolean,
    onToggleContents: () -> Unit,
    onAddAll: () -> Unit,
    onCloseBox: () -> Unit,
    onCancelBox: () -> Unit,
) {
    val done = box.status != "open"
    Card(
        modifier = Modifier.fillMaxWidth(),
        border = if (done) BorderStroke(1.dp, CardDoneColor) else null,
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(box.id, style = MaterialTheme.typography.titleMedium)
                StatusBadge(box.status, family = "box")
            }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.put_away_box_lines_qty, box.lineCount, box.totalQty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (box.contents.isNotEmpty()) {
                    IconButton(onClick = onToggleContents) {
                        Icon(
                            if (contentsExpanded) Icons.Filled.KeyboardArrowUp
                            else Icons.Filled.KeyboardArrowDown,
                            contentDescription = null,
                        )
                    }
                }
            }
            if (contentsExpanded) {
                Column(Modifier.padding(start = 12.dp)) {
                    for (content in box.contents) {
                        Text(
                            "${content.partNo ?: stringResource(R.string.common_no_data)} × ${content.qty}",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(vertical = 1.dp),
                        )
                    }
                }
            }
            if (box.status == "open") {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = onAddAll,
                        enabled = !actionInProgress && unboxedCount > 0,
                    ) {
                        Text(stringResource(R.string.put_away_add_all))
                    }
                    // Close needs contents; only an empty box can be cancelled (web parity).
                    if (box.lineCount > 0) {
                        OutlinedButton(onClick = onCloseBox, enabled = !actionInProgress) {
                            Text(stringResource(R.string.put_away_close_box))
                        }
                    } else {
                        OutlinedButton(onClick = onCancelBox, enabled = !actionInProgress) {
                            Text(stringResource(R.string.put_away_cancel_box))
                        }
                    }
                }
            }
        }
    }
}
