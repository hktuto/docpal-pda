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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.PickingAllocationDetail
import com.docpal.warehousepda.domain.model.PickingBoxDetail
import com.docpal.warehousepda.domain.model.PickingItemDetail
import com.docpal.warehousepda.domain.model.PickingItemLogEntry
import com.docpal.warehousepda.domain.model.PickingOrderDetail
import com.docpal.warehousepda.domain.model.PickingPackageDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.StatusBadge
import com.docpal.warehousepda.ui.receiving.logStateLabel
import org.json.JSONException
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Web card--done green (StatusBadge "finished"); also used by the boxes section. */
internal val CardDoneColor = Color(0xFF10B981)

/**
 * Items section — port of the web PickingItemsSection.vue.
 * Rendered inside the detail screen's LazyColumn. Scan buttons pin the
 * allocation and launch the camera (Task 10).
 */
internal fun LazyListScope.pickingItemsSection(
    detail: PickingOrderDetail,
    logs: Map<String, List<PickingItemLogEntry>>,
    boxSelections: Map<String, String>,
    expandedLogs: Set<String>,
    actionInProgress: Boolean,
    scanEnabled: Boolean = false,
    onSelectBox: (packageId: String, boxId: String) -> Unit,
    onToggleLogs: (itemId: String) -> Unit,
    onAddToBox: (packageId: String) -> Unit,
    onRemoveFromBox: (packageId: String) -> Unit,
    onScanAllocation: (allocation: PickingAllocationDetail, item: PickingItemDetail) -> Unit = { _, _ -> },
) {
    item(key = "items-title") {
        Text(
            stringResource(R.string.picking_items_title),
            style = MaterialTheme.typography.titleMedium,
        )
    }
    val openBoxes = detail.boxes.filter { it.status == "open" }
    for (item in detail.items) {
        item(key = "picking-item-${item.id}") {
            PickingItemCard(
                item = item,
                orderStatus = detail.status,
                logs = logs[item.id].orEmpty(),
                openBoxes = openBoxes,
                allBoxes = detail.boxes,
                selectedBoxId = { pkgId -> boxSelections[pkgId] },
                logsExpanded = item.id in expandedLogs,
                actionInProgress = actionInProgress,
                scanEnabled = scanEnabled,
                onSelectBox = onSelectBox,
                onToggleLogs = { onToggleLogs(item.id) },
                onAddToBox = onAddToBox,
                onRemoveFromBox = onRemoveFromBox,
                onScanAllocation = { allocation -> onScanAllocation(allocation, item) },
            )
        }
    }
}

@Composable
private fun PickingItemCard(
    item: PickingItemDetail,
    orderStatus: String,
    logs: List<PickingItemLogEntry>,
    openBoxes: List<PickingBoxDetail>,
    allBoxes: List<PickingBoxDetail>,
    selectedBoxId: (packageId: String) -> String?,
    logsExpanded: Boolean,
    actionInProgress: Boolean,
    scanEnabled: Boolean,
    onSelectBox: (packageId: String, boxId: String) -> Unit,
    onToggleLogs: () -> Unit,
    onAddToBox: (packageId: String) -> Unit,
    onRemoveFromBox: (packageId: String) -> Unit,
    onScanAllocation: (allocation: PickingAllocationDetail) -> Unit,
) {
    val done = item.pickedQty >= item.qty
    val actionable = orderStatus != "finished" && orderStatus != "issue"
    Card(
        modifier = Modifier.fillMaxWidth(),
        border = if (done) BorderStroke(1.dp, CardDoneColor) else null,
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            DetailRow(stringResource(R.string.picking_items_part), item.partNo)
            DetailRow(stringResource(R.string.picking_items_required_qty), item.qty.toString())
            DetailRow(stringResource(R.string.picking_items_scanned_qty), item.scannedQty.toString())
            DetailRow(stringResource(R.string.picking_items_boxed_qty), item.pickedQty.toString())
            DetailRow(stringResource(R.string.picking_items_required_date_code), item.requiredDateCode)
            StatusDetailRow(
                stringResource(R.string.picking_items_status),
                if (done) "finished" else "picking",
                "picking",
            )

            // Allocations only matter while the item still needs picking (web parity).
            if (item.allocations.isNotEmpty() && actionable && !done) {
                Spacer(Modifier.height(8.dp))
                SectionLabel(stringResource(R.string.picking_items_allocations))
                for (allocation in item.allocations) {
                    AllocationBlock(allocation, actionInProgress, scanEnabled, onScanAllocation)
                }
            }

            val unboxed = item.packages.filter { it.shippingBoxId == null }
            if (unboxed.isNotEmpty() && actionable) {
                Spacer(Modifier.height(8.dp))
                SectionLabel(stringResource(R.string.picking_items_unboxed_packages))
                for (pkg in unboxed) {
                    UnboxedPackageRow(
                        pkg = pkg,
                        openBoxes = openBoxes,
                        selectedBoxId = selectedBoxId(pkg.id),
                        actionInProgress = actionInProgress,
                        onSelectBox = { boxId -> onSelectBox(pkg.id, boxId) },
                        onAddToBox = { onAddToBox(pkg.id) },
                    )
                }
            }

            val boxed = item.packages.filter { it.shippingBoxId != null }
            if (boxed.isNotEmpty() && actionable) {
                Spacer(Modifier.height(8.dp))
                SectionLabel(stringResource(R.string.picking_items_boxed_packages))
                for (pkg in boxed) {
                    val boxOpen = allBoxes.firstOrNull { it.id == pkg.shippingBoxId }?.status == "open"
                    Row(
                        Modifier.fillMaxWidth().padding(top = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${pkg.qty} ${stringResource(R.string.common_pcs)} · ${pkg.shippingBoxId}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        // Remove only while the box can still change (web openBoxById check).
                        if (boxOpen) {
                            OutlinedButton(
                                onClick = { onRemoveFromBox(pkg.id) },
                                enabled = !actionInProgress,
                            ) {
                                Text(
                                    stringResource(
                                        if (actionInProgress) R.string.picking_items_removing
                                        else R.string.picking_items_remove
                                    )
                                )
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onToggleLogs) {
                Text(
                    stringResource(
                        if (logsExpanded) R.string.picking_items_hide_logs
                        else R.string.picking_items_show_logs
                    ) + " (${logs.size})"
                )
            }
            if (logsExpanded) PickingItemLogs(logs)
        }
    }
}

@Composable
private fun AllocationBlock(
    allocation: PickingAllocationDetail,
    actionInProgress: Boolean,
    scanEnabled: Boolean,
    onScanAllocation: (allocation: PickingAllocationDetail) -> Unit,
) {
    Column(Modifier.padding(start = 12.dp, top = 4.dp)) {
        if (allocation.lotId != null) {
            val location = when {
                allocation.shelfCode != null && allocation.boxId != null ->
                    "${allocation.shelfCode} / ${allocation.boxId}"
                allocation.shelfCode != null -> allocation.shelfCode
                allocation.boxId != null -> allocation.boxId
                else -> stringResource(R.string.picking_items_receiving_area)
            }
            DetailRow(stringResource(R.string.picking_items_location), location)
            DetailRow(
                stringResource(R.string.picking_items_date_lot_coo_cow),
                dateLotCooCow(allocation.dateCode, allocation.lotCode, allocation.coo, allocation.cow),
            )
            DetailRow(stringResource(R.string.picking_items_allocated_qty), allocation.qty.toString())
        } else if (allocation.receivingOrderId != null) {
            val source = stringResource(R.string.picking_items_receiving_area) +
                (allocation.receivingOrderRefNo?.let { " ($it)" } ?: "")
            DetailRow(stringResource(R.string.picking_items_source), source)
            DetailRow(stringResource(R.string.picking_items_allocated_qty), allocation.qty.toString())
            if (allocation.boxIds.isNotEmpty()) {
                DetailRow(
                    stringResource(R.string.picking_items_box_ids),
                    allocation.boxIds.joinToString(", "),
                )
            }
        }
        // Scan pins this allocation and launches the camera (Task 10).
        Spacer(Modifier.height(4.dp))
        OutlinedButton(
            onClick = { onScanAllocation(allocation) },
            enabled = scanEnabled && !actionInProgress,
        ) {
            Text(stringResource(R.string.picking_items_scan))
        }
    }
}

@Composable
private fun UnboxedPackageRow(
    pkg: PickingPackageDetail,
    openBoxes: List<PickingBoxDetail>,
    selectedBoxId: String?,
    actionInProgress: Boolean,
    onSelectBox: (boxId: String) -> Unit,
    onAddToBox: () -> Unit,
) {
    Column(Modifier.padding(start = 12.dp, top = 4.dp)) {
        Text(
            "${pkg.qty} ${stringResource(R.string.common_pcs)} · " +
                dateLotCooCow(pkg.dateCode, pkg.lotCode, pkg.coo, pkg.cow),
            style = MaterialTheme.typography.bodySmall,
        )
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
                    Text(
                        stringResource(
                            if (actionInProgress) R.string.picking_items_adding
                            else R.string.picking_items_add_to_box
                        )
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BoxSelector(
    boxes: List<PickingBoxDetail>,
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
            label = { Text(stringResource(R.string.picking_items_select_box)) },
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

/** Web logs list: timestamp · actor · from → to (+ metadata suffix when present). */
@Composable
private fun PickingItemLogs(logs: List<PickingItemLogEntry>) {
    if (logs.isEmpty()) {
        Text(
            stringResource(R.string.picking_items_no_logs),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    Column(Modifier.padding(start = 12.dp, top = 4.dp)) {
        for (log in logs) {
            val metadata = logMetadataText(log.metadata)
            Text(
                "${formatLogTime(log.createdAt)} · " +
                    (log.actorName ?: stringResource(R.string.common_actor_system)) +
                    " · ${logStateLabel(log.fromState)} → ${logStateLabel(log.toState)}" +
                    (metadata?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 1.dp),
            )
        }
    }
}

/** DetailRow-shaped status line: label above an inline [StatusBadge]. */
@Composable
internal fun StatusDetailRow(label: String, status: String, family: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(2.dp))
        StatusBadge(status, family = family)
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

/** Web formatLotFields: "{dateCode|—} / {lotCode|—} / {coo|—} / {cow|—}". */
@Composable
private fun dateLotCooCow(dateCode: String?, lotCode: String?, coo: String?, cow: String?): String {
    val none = stringResource(R.string.common_state_none)
    return "${dateCode ?: none} / ${lotCode ?: none} / ${coo ?: none} / ${cow ?: none}"
}

/** Web logMetadataText: metadata JSON's qty, else note; null on missing/malformed. */
private fun logMetadataText(metadata: String?): String? {
    if (metadata.isNullOrEmpty()) return null
    return try {
        val json = JSONObject(metadata)
        when {
            json.has("qty") -> json.get("qty").toString()
            json.has("note") -> json.getString("note")
            else -> null
        }
    } catch (e: JSONException) {
        null
    }
}

/** epoch ms → yyyy-MM-dd HH:mm in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatLogTime(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
