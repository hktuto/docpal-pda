package com.docpal.warehousepda.ui.putaway

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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.PutAwayBoxDetail
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.domain.model.PutAwayLotDetail
import com.docpal.warehousepda.domain.model.PutAwayScanDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.EmptyState

/** Web scan-box--unboxed warning color. */
private val UnboxedWarningColor = Color(0xFFF59E0B)

/**
 * Lots section — port of the web PutAwayLotsPanel.vue.
 * Rendered inside the detail screen's LazyColumn. The Scan buttons are wired in
 * Task 10 — they render behind [scanEnabled] (Task 9 screens pass false).
 */
internal fun LazyListScope.putAwayLotsSection(
    detail: PutAwayDetail,
    boxSelections: Map<String, String>,
    expandedLots: Set<String>,
    actionInProgress: Boolean,
    scanEnabled: Boolean = false,
    onSelectBox: (scanId: String, boxId: String) -> Unit,
    onToggleScans: (itemId: String) -> Unit,
    onAddToBox: (scanId: String) -> Unit,
    onRemoveFromBox: (scanId: String) -> Unit,
    onRemoveScan: (scanId: String) -> Unit,
    onScanLot: (lot: PutAwayLotDetail) -> Unit = {},
) {
    item(key = "lots-title") {
        Text(
            stringResource(R.string.put_away_lots_title),
            style = MaterialTheme.typography.titleMedium,
        )
    }
    if (detail.lots.isEmpty()) {
        item { EmptyState(stringResource(R.string.common_no_lots)) }
        return
    }
    val openBoxes = detail.boxes.filter { it.status == "open" }
    for (lot in detail.lots) {
        // Client-side grouping, like the web scansByItem computed.
        val lotScans =
            detail.scans.filter { it.receivingInvoiceItemId == lot.receivingInvoiceItemId }
        item(key = "lot-${lot.receivingInvoiceItemId}") {
            PutAwayLotCard(
                lot = lot,
                scans = lotScans,
                openBoxes = openBoxes,
                allBoxes = detail.boxes,
                scansExpanded = lot.receivingInvoiceItemId in expandedLots,
                selectedBoxId = { scanId -> boxSelections[scanId] },
                actionInProgress = actionInProgress,
                scanEnabled = scanEnabled,
                onSelectBox = onSelectBox,
                onToggleScans = { onToggleScans(lot.receivingInvoiceItemId) },
                onAddToBox = onAddToBox,
                onRemoveFromBox = onRemoveFromBox,
                onRemoveScan = onRemoveScan,
                onScan = { onScanLot(lot) },
            )
        }
    }
}

@Composable
private fun PutAwayLotCard(
    lot: PutAwayLotDetail,
    scans: List<PutAwayScanDetail>,
    openBoxes: List<PutAwayBoxDetail>,
    allBoxes: List<PutAwayBoxDetail>,
    scansExpanded: Boolean,
    selectedBoxId: (scanId: String) -> String?,
    actionInProgress: Boolean,
    scanEnabled: Boolean,
    onSelectBox: (scanId: String, boxId: String) -> Unit,
    onToggleScans: () -> Unit,
    onAddToBox: (scanId: String) -> Unit,
    onRemoveFromBox: (scanId: String) -> Unit,
    onRemoveScan: (scanId: String) -> Unit,
    onScan: () -> Unit,
) {
    val none = stringResource(R.string.common_no_data)
    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            DetailRow(stringResource(R.string.put_away_part), lot.partNo)
            DetailRow(
                stringResource(R.string.put_away_date_lot),
                "${lot.dateCode ?: none} / ${lot.lotCode ?: none}",
            )
            DetailRow(
                stringResource(R.string.put_away_coo_cow),
                "${lot.coo ?: none} / ${lot.cow ?: none}",
            )
            DetailRow(stringResource(R.string.put_away_total_qty), lot.totalQty.toString())
            DetailRow(stringResource(R.string.put_away_scanned_qty), lot.scannedQty.toString())
            DetailRow(stringResource(R.string.put_away_boxed_qty), lot.boxedQty.toString())

            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // Scan-to-put-away is Task 10 — the button renders disabled until then.
                OutlinedButton(onClick = onScan, enabled = scanEnabled && !actionInProgress) {
                    Text(stringResource(R.string.put_away_scan_piece))
                }
                TextButton(onClick = onToggleScans) {
                    Text(
                        if (scansExpanded) stringResource(R.string.put_away_hide_scans)
                        else stringResource(R.string.put_away_show_scans, scans.size)
                    )
                }
            }

            if (scansExpanded) {
                if (scans.isEmpty()) {
                    Text(
                        stringResource(R.string.put_away_no_scans),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 12.dp, top = 4.dp),
                    )
                }
                for (scan in scans) {
                    ScanRow(
                        scan = scan,
                        openBoxes = openBoxes,
                        boxOpen = allBoxes.firstOrNull { it.id == scan.shelfBoxId }?.status == "open",
                        selectedBoxId = selectedBoxId(scan.id),
                        actionInProgress = actionInProgress,
                        onSelectBox = { boxId -> onSelectBox(scan.id, boxId) },
                        onAddToBox = { onAddToBox(scan.id) },
                        onRemoveFromBox = { onRemoveFromBox(scan.id) },
                        onRemoveScan = { onRemoveScan(scan.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ScanRow(
    scan: PutAwayScanDetail,
    openBoxes: List<PutAwayBoxDetail>,
    boxOpen: Boolean,
    selectedBoxId: String?,
    actionInProgress: Boolean,
    onSelectBox: (boxId: String) -> Unit,
    onAddToBox: () -> Unit,
    onRemoveFromBox: () -> Unit,
    onRemoveScan: () -> Unit,
) {
    Column(Modifier.padding(start = 12.dp, top = 4.dp)) {
        Text(
            "${scan.qty} ${stringResource(R.string.common_pcs)}",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(
            dateLotCooCow(scan.dateCode, scan.lotCode, scan.coo, scan.cow),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (scan.shelfBoxId != null) {
            Text(
                stringResource(R.string.common_in_box, scan.shelfBoxId),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(
                stringResource(R.string.common_unboxed),
                style = MaterialTheme.typography.bodySmall,
                color = UnboxedWarningColor,
            )
        }

        if (scan.shelfBoxId == null) {
            if (openBoxes.isEmpty()) {
                Text(
                    stringResource(R.string.common_create_open_box_first),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
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
                        Text(stringResource(R.string.put_away_add_to_box))
                    }
                    OutlinedButton(onClick = onRemoveScan, enabled = !actionInProgress) {
                        Text(stringResource(R.string.put_away_remove_scan))
                    }
                }
            }
        } else if (boxOpen) {
            // Remove only while the box can still change (web boxById(status) check);
            // scans in a closed box have no actions.
            OutlinedButton(onClick = onRemoveFromBox, enabled = !actionInProgress) {
                Text(stringResource(R.string.put_away_remove_from_box))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BoxSelector(
    boxes: List<PutAwayBoxDetail>,
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
            label = { Text(stringResource(R.string.put_away_select_box)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled = enabled),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (box in boxes) {
                DropdownMenuItem(
                    text = {
                        Text(
                            "${box.id} · ${box.shelfCode ?: stringResource(R.string.common_no_data)}"
                        )
                    },
                    onClick = {
                        onSelectBox(box.id)
                        expanded = false
                    },
                )
            }
        }
    }
}

/** Web formatLotFields for scan rows: "{dateCode|—} / {lotCode|—} / {coo|—} / {cow|—}". */
@Composable
private fun dateLotCooCow(dateCode: String?, lotCode: String?, coo: String?, cow: String?): String {
    val none = stringResource(R.string.common_state_none)
    return "${dateCode ?: none} / ${lotCode ?: none} / ${coo ?: none} / ${cow ?: none}"
}
