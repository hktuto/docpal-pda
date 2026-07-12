package com.docpal.warehousepda.ui.receiving

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.DisplayBox
import com.docpal.warehousepda.domain.model.DisplayPackage
import com.docpal.warehousepda.domain.model.PickingByReceivingRow
import com.docpal.warehousepda.domain.model.PickingItemLog
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.StatusBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Picking tab content — port of the web ReceivingPickingTab.vue.
 * Rows grouped by picking order; the order ref links to the picking detail screen.
 * Rendered inside the detail screen's LazyColumn.
 */
internal fun LazyListScope.receivingPickingTabContent(
    detail: ReceivingOrderDetail,
    actionInProgress: Boolean,
    boxSelections: Map<String, String>,
    expandedLogs: Set<String>,
    onPickingOrderClick: (pickingOrderId: String) -> Unit,
    onSelectBox: (packageId: String, boxId: String) -> Unit,
    onToggleLogs: (pickingItemId: String) -> Unit,
    onCreateBox: (pickingOrderId: String) -> Unit,
    onAddAll: (boxId: String, unboxedCount: Int) -> Unit,
    onAddToBox: (packageId: String) -> Unit,
    onRemoveFromBox: (packageId: String) -> Unit,
    onRemoveScan: (packageId: String) -> Unit,
    onScanItem: (pickingItemId: String) -> Unit,
) {
    if (detail.pickingRows.isEmpty()) {
        item { EmptyState(stringResource(R.string.common_no_picking_orders_linked)) }
        return
    }
    val rowsByOrder = detail.pickingRows.groupBy { it.pickingOrderId }
    for ((orderId, orderRows) in rowsByOrder) {
        item(key = "picking-order-$orderId") {
            PickingOrderSection(
                orderId = orderId,
                orderRows = orderRows,
                detail = detail,
                actionInProgress = actionInProgress,
                boxSelections = boxSelections,
                expandedLogs = expandedLogs,
                onPickingOrderClick = onPickingOrderClick,
                onSelectBox = onSelectBox,
                onToggleLogs = onToggleLogs,
                onCreateBox = onCreateBox,
                onAddAll = onAddAll,
                onAddToBox = onAddToBox,
                onRemoveFromBox = onRemoveFromBox,
                onRemoveScan = onRemoveScan,
                onScanItem = onScanItem,
            )
        }
    }
}

@Composable
private fun PickingOrderSection(
    orderId: String,
    orderRows: List<PickingByReceivingRow>,
    detail: ReceivingOrderDetail,
    actionInProgress: Boolean,
    boxSelections: Map<String, String>,
    expandedLogs: Set<String>,
    onPickingOrderClick: (pickingOrderId: String) -> Unit,
    onSelectBox: (packageId: String, boxId: String) -> Unit,
    onToggleLogs: (pickingItemId: String) -> Unit,
    onCreateBox: (pickingOrderId: String) -> Unit,
    onAddAll: (boxId: String, unboxedCount: Int) -> Unit,
    onAddToBox: (packageId: String) -> Unit,
    onRemoveFromBox: (packageId: String) -> Unit,
    onRemoveScan: (packageId: String) -> Unit,
    onScanItem: (pickingItemId: String) -> Unit,
) {
    val first = orderRows.first()
    val boxes = detail.boxesByOrder[orderId].orEmpty()
    val itemIds = orderRows.map { it.pickingItemId }.toSet()
    val unboxedCount = itemIds.sumOf { id ->
        detail.packagesByItem[id].orEmpty().count { it.shippingBoxId == null }
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Web links to the picking order.
                TextButton(onClick = { onPickingOrderClick(orderId) }) {
                    Text(first.pickingOrderRef, style = MaterialTheme.typography.titleMedium)
                }
                StatusBadge(first.pickingOrderStatus, family = "picking")
            }
            if (first.pickingOrderStatus != "finished") {
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = { onCreateBox(orderId) }, enabled = !actionInProgress) {
                    Text(
                        stringResource(
                            if (actionInProgress) R.string.receiving_picking_tab_creating
                            else R.string.receiving_picking_tab_create_box
                        )
                    )
                }
            }
            if (boxes.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                SectionLabel(stringResource(R.string.receiving_picking_tab_boxes))
                for (box in boxes) {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(box.id, style = MaterialTheme.typography.bodyMedium)
                            Spacer(Modifier.width(4.dp))
                            StatusBadge(box.status, family = "box")
                        }
                        if (box.status == "open" && unboxedCount > 0) {
                            OutlinedButton(
                                onClick = { onAddAll(box.id, unboxedCount) },
                                enabled = !actionInProgress,
                            ) {
                                Text(stringResource(R.string.receiving_picking_tab_add_all))
                            }
                        }
                    }
                }
            }
            val rowsByItem = orderRows.groupBy { it.pickingItemId }
            for ((itemId, itemRows) in rowsByItem) {
                Spacer(Modifier.height(8.dp))
                HorizontalDivider()
                Spacer(Modifier.height(8.dp))
                PickingItemBlock(
                    itemId = itemId,
                    itemRows = itemRows,
                    packages = detail.packagesByItem[itemId].orEmpty(),
                    logs = detail.transitionLogs[itemId].orEmpty(),
                    boxes = boxes,
                    selectedBoxId = { pkgId -> boxSelections[pkgId] },
                    logsExpanded = itemId in expandedLogs,
                    actionInProgress = actionInProgress,
                    onSelectBox = onSelectBox,
                    onToggleLogs = onToggleLogs,
                    onAddToBox = onAddToBox,
                    onRemoveFromBox = onRemoveFromBox,
                    onRemoveScan = onRemoveScan,
                    onScanItem = onScanItem,
                )
            }
        }
    }
}

@Composable
private fun PickingItemBlock(
    itemId: String,
    itemRows: List<PickingByReceivingRow>,
    packages: List<DisplayPackage>,
    logs: List<PickingItemLog>,
    boxes: List<DisplayBox>,
    selectedBoxId: (packageId: String) -> String?,
    logsExpanded: Boolean,
    actionInProgress: Boolean,
    onSelectBox: (packageId: String, boxId: String) -> Unit,
    onToggleLogs: (pickingItemId: String) -> Unit,
    onAddToBox: (packageId: String) -> Unit,
    onRemoveFromBox: (packageId: String) -> Unit,
    onRemoveScan: (packageId: String) -> Unit,
    onScanItem: (pickingItemId: String) -> Unit,
) {
    val first = itemRows.first()
    DetailRow(stringResource(R.string.receiving_items_tab_part), first.partNo)
    DetailRow(
        stringResource(R.string.receiving_picking_tab_required_scanned_boxed),
        "${first.requiredQty} / ${first.scannedQty} / ${first.boxedQty}",
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            stringResource(R.string.receiving_picking_tab_status),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(4.dp))
        StatusBadge(
            if (first.boxedQty >= first.requiredQty) "finished" else "picking",
            family = "picking",
        )
    }

    val allocations = itemRows.filter { it.allocatedQty > 0 }
    if (allocations.isNotEmpty()) {
        Spacer(Modifier.height(4.dp))
        SectionLabel(stringResource(R.string.receiving_picking_tab_allocated_lots))
        for (row in allocations) AllocationLine(row)
    }

    if (packages.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        SectionLabel(stringResource(R.string.receiving_picking_tab_packages))
        for (pkg in packages) {
            PackageRow(
                pkg = pkg,
                boxes = boxes,
                selectedBoxId = selectedBoxId(pkg.id),
                actionInProgress = actionInProgress,
                onSelectBox = { boxId -> onSelectBox(pkg.id, boxId) },
                onAddToBox = { onAddToBox(pkg.id) },
                onRemoveFromBox = { onRemoveFromBox(pkg.id) },
                onRemoveScan = { onRemoveScan(pkg.id) },
            )
        }
    }

    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { onScanItem(itemId) }, enabled = !actionInProgress) {
            Text(stringResource(R.string.receiving_picking_tab_scan))
        }
        OutlinedButton(onClick = { onToggleLogs(itemId) }) {
            Text(
                stringResource(
                    if (logsExpanded) R.string.receiving_picking_tab_hide_logs
                    else R.string.receiving_picking_tab_show_logs
                ) + " (${logs.size})"
            )
        }
    }
    if (logsExpanded) PickingLogs(logs)
}

/** Web allocatedLocations line: location · date/lot/coo/cow · qty pcs. */
@Composable
private fun AllocationLine(row: PickingByReceivingRow) {
    val none = stringResource(R.string.common_state_none)
    val location = row.shelfCode
        ?: (row.boxId?.let { stringResource(R.string.common_in_box, it) }
            ?: stringResource(R.string.receiving_picking_tab_receiving_area))
    Text(
        "$location · ${row.dateCode ?: none} / ${row.lotCode ?: none} / " +
            "${row.coo ?: none} / ${row.cow ?: none} · " +
            "${row.allocatedQty} ${stringResource(R.string.common_pcs)}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 12.dp, top = 2.dp),
    )
}

@Composable
private fun PackageRow(
    pkg: DisplayPackage,
    boxes: List<DisplayBox>,
    selectedBoxId: String?,
    actionInProgress: Boolean,
    onSelectBox: (boxId: String) -> Unit,
    onAddToBox: () -> Unit,
    onRemoveFromBox: () -> Unit,
    onRemoveScan: () -> Unit,
) {
    val none = stringResource(R.string.common_state_none)
    Column(Modifier.padding(start = 12.dp, top = 4.dp)) {
        Text(
            "${pkg.qty} ${stringResource(R.string.common_pcs)} · " +
                "${pkg.dateCode ?: none} / ${pkg.lotCode ?: none} / " +
                "${pkg.coo ?: none} / ${pkg.cow ?: none}",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(
            pkg.shippingBoxId?.let { stringResource(R.string.common_in_box, it) }
                ?: stringResource(R.string.common_unboxed),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val box = boxes.firstOrNull { it.id == pkg.shippingBoxId }
        when {
            pkg.shippingBoxId == null -> {
                Spacer(Modifier.height(4.dp))
                val openBoxes = boxes.filter { it.status == "open" }
                if (openBoxes.isEmpty()) {
                    Text(
                        stringResource(R.string.common_create_open_box_first),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BoxSelector(
                            boxes = openBoxes,
                            selectedBoxId = selectedBoxId,
                            enabled = !actionInProgress,
                            onSelectBox = onSelectBox,
                        )
                        OutlinedButton(
                            onClick = onAddToBox,
                            enabled = !actionInProgress && selectedBoxId != null,
                        ) {
                            Text(stringResource(R.string.receiving_picking_tab_add_to_box))
                        }
                        OutlinedButton(onClick = onRemoveScan, enabled = !actionInProgress) {
                            Text(stringResource(R.string.receiving_picking_tab_remove_scanned))
                        }
                    }
                }
            }
            box?.status == "open" -> {
                Spacer(Modifier.height(4.dp))
                OutlinedButton(onClick = onRemoveFromBox, enabled = !actionInProgress) {
                    Text(stringResource(R.string.receiving_picking_tab_remove_from_box))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BoxSelector(
    boxes: List<DisplayBox>,
    selectedBoxId: String?,
    enabled: Boolean,
    onSelectBox: (boxId: String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { if (enabled) expanded = it },
    ) {
        OutlinedTextField(
            value = selectedBoxId ?: "",
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            enabled = enabled,
            label = { Text(stringResource(R.string.receiving_picking_tab_select_box)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled = enabled),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (box in boxes) {
                DropdownMenuItem(
                    text = { Text(box.id) },
                    onClick = {
                        onSelectBox(box.id)
                        expanded = false
                    },
                )
            }
        }
    }
}

/** Web transitionLogs list: timestamp · actor · from → to. */
@Composable
private fun PickingLogs(logs: List<PickingItemLog>) {
    if (logs.isEmpty()) {
        Text(
            stringResource(R.string.receiving_picking_tab_no_logs),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    Column(Modifier.padding(start = 12.dp, top = 4.dp)) {
        for (log in logs) {
            Text(
                "${formatLogTime(log.createdAt)} · " +
                    (log.actorName ?: stringResource(R.string.common_actor_system)) +
                    " · ${logStateLabel(log.fromState)} → ${logStateLabel(log.toState)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Web logStateLabel: `log_state_<code>` when known, raw code otherwise (null → log_state_none). */
@Composable
internal fun logStateLabel(state: String?): String {
    if (state == null) return stringResource(R.string.log_state_none)
    val res = when (state) {
        "pending" -> R.string.log_state_pending
        "in_hand" -> R.string.log_state_in_hand
        "clear" -> R.string.log_state_clear
        "picking" -> R.string.log_state_picking
        "finished" -> R.string.log_state_finished
        "issue" -> R.string.log_state_issue
        "open" -> R.string.log_state_open
        "closed" -> R.string.log_state_closed
        "verified" -> R.string.log_state_verified
        "unverified" -> R.string.log_state_unverified
        "scanned" -> R.string.log_state_scanned
        "boxed" -> R.string.log_state_boxed
        "removed" -> R.string.log_state_removed
        "mismatch_reported" -> R.string.log_state_mismatch_reported
        "cancelled" -> R.string.log_state_cancelled
        "completed" -> R.string.log_state_completed
        "not_found" -> R.string.log_state_not_found
        "damaged" -> R.string.log_state_damaged
        "qty_mismatch" -> R.string.log_state_qty_mismatch
        "wrong_part" -> R.string.log_state_wrong_part
        "over_shipment" -> R.string.log_state_over_shipment
        "quality_rejection" -> R.string.log_state_quality_rejection
        else -> null
    }
    return res?.let { stringResource(it) } ?: state
}

/** epoch ms → yyyy-MM-dd HH:mm in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatLogTime(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
