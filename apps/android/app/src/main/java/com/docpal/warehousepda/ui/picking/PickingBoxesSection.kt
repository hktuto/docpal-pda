package com.docpal.warehousepda.ui.picking

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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import com.docpal.warehousepda.domain.model.PickingBoxDetail
import com.docpal.warehousepda.domain.model.PickingOrderDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.EmptyState

/**
 * Boxes section — port of the web PickingBoxesSection.vue.
 * Rendered inside the detail screen's LazyColumn; collapsed by default,
 * force-expanded by the screen after creating a box.
 */
internal fun LazyListScope.pickingBoxesSection(
    detail: PickingOrderDetail,
    expanded: Boolean,
    actionInProgress: Boolean,
    onToggleExpanded: () -> Unit,
    onCreateBox: () -> Unit,
    onAddAll: (boxId: String, unboxedCount: Int) -> Unit,
    onCancelBox: (boxId: String) -> Unit,
) {
    val actionable = detail.status != "finished" && detail.status != "issue"
    val unboxedCount = detail.items.sumOf { item ->
        item.packages.count { it.shippingBoxId == null }
    }
    item(key = "boxes-header") {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.picking_boxes_title, detail.boxes.size),
                style = MaterialTheme.typography.titleMedium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (actionable) {
                    OutlinedButton(onClick = onCreateBox, enabled = !actionInProgress) {
                        Text(stringResource(R.string.picking_boxes_new_box))
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
    items(detail.boxes, key = { it.id }) { box ->
        BoxCard(
            box = box,
            unboxedCount = unboxedCount,
            actionInProgress = actionInProgress,
            onAddAll = { onAddAll(box.id, unboxedCount) },
            onCancelBox = { onCancelBox(box.id) },
        )
    }
}

@Composable
private fun BoxCard(
    box: PickingBoxDetail,
    unboxedCount: Int,
    actionInProgress: Boolean,
    onAddAll: () -> Unit,
    onCancelBox: () -> Unit,
) {
    val done = box.status != "open"
    Card(
        modifier = Modifier.fillMaxWidth(),
        border = if (done) BorderStroke(1.dp, CardDoneColor) else null,
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            DetailRow(stringResource(R.string.picking_boxes_box_id), box.id)
            StatusDetailRow(stringResource(R.string.picking_boxes_status), box.status, "box")
            DetailRow(stringResource(R.string.picking_boxes_packages), box.packageCount.toString())
            DetailRow(stringResource(R.string.picking_boxes_qty), box.totalQty.toString())
            if (box.status == "open") {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = onAddAll,
                        enabled = !actionInProgress && unboxedCount > 0,
                    ) {
                        Text(stringResource(R.string.picking_boxes_add_all))
                    }
                    // Only an empty box can be cancelled (web parity).
                    if (box.packageCount == 0) {
                        OutlinedButton(onClick = onCancelBox, enabled = !actionInProgress) {
                            Text(
                                stringResource(
                                    if (actionInProgress) R.string.picking_boxes_canceling
                                    else R.string.picking_boxes_cancel_box
                                )
                            )
                        }
                    }
                }
            }
        }
    }
}
