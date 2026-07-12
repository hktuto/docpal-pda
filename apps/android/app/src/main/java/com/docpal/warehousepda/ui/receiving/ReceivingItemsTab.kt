package com.docpal.warehousepda.ui.receiving

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.MismatchRules
import com.docpal.warehousepda.domain.model.MismatchInfo
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.EmptyState

/**
 * Receiving items tab content — port of the web ReceivingItemsTab.vue.
 * Rendered inside the detail screen's LazyColumn; [currentUserId]/[actionInProgress]
 * come from the screen's single uiState collection so cards stay reactive.
 */
@OptIn(ExperimentalFoundationApi::class)
internal fun LazyListScope.receivingItemsTabContent(
    detail: ReceivingOrderDetail,
    currentUserId: String?,
    actionInProgress: Boolean,
    onReportIssue: (ReceivingItemDetail) -> Unit,
    onConfirmMismatch: (mismatchId: String) -> Unit,
    onCancelMismatch: (mismatchId: String) -> Unit,
) {
    if (detail.invoices.all { it.items.isEmpty() }) {
        item { EmptyState(stringResource(R.string.common_no_data)) }
    }
    for (invoice in detail.invoices) {
        stickyHeader {
            Text(
                stringResource(R.string.common_invoice_title, invoice.invoiceNo),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(vertical = 4.dp),
            )
        }
        items(invoice.items, key = { it.id }) { item ->
            ItemCard(
                item = item,
                orderStatus = detail.status,
                currentUserId = currentUserId,
                actionInProgress = actionInProgress,
                onReportIssue = { onReportIssue(item) },
                onConfirmMismatch = onConfirmMismatch,
                onCancelMismatch = onCancelMismatch,
            )
        }
    }
}

@Composable
private fun ItemCard(
    item: ReceivingItemDetail,
    orderStatus: String,
    currentUserId: String?,
    actionInProgress: Boolean,
    onReportIssue: () -> Unit,
    onConfirmMismatch: (mismatchId: String) -> Unit,
    onCancelMismatch: (mismatchId: String) -> Unit,
) {
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    DetailRow(stringResource(R.string.receiving_items_tab_part), item.partNo)
                }
                IconButton(onClick = { expanded = !expanded }) {
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                        contentDescription = null,
                    )
                }
            }
            DetailRow(stringResource(R.string.receiving_items_tab_expected), item.qty.toString())
            if (item.boxId != null) {
                DetailRow(stringResource(R.string.receiving_items_tab_box_id), item.boxId)
            }
            if (expanded) {
                val poLine = listOfNotNull(item.poNo, item.poLine).joinToString(" / ")
                DetailRow(stringResource(R.string.receiving_items_tab_po_line), poLine)
                DetailRow(stringResource(R.string.receiving_items_tab_reserved), item.allocatedQty.toString())
                DetailRow(stringResource(R.string.receiving_items_tab_picked), item.pickedQty.toString())
                DetailRow(stringResource(R.string.receiving_items_tab_put_away), item.putAwayQty.toString())
                DetailRow(stringResource(R.string.receiving_items_tab_available), item.availableQty.toString())
                val dateLotCooCow = listOfNotNull(item.dateCode, item.lotCode, item.coo, item.cow)
                    .joinToString(" / ")
                DetailRow(stringResource(R.string.receiving_items_tab_date_lot_coo_cow), dateLotCooCow)
            }
            // Mismatch actions only exist while the order can still receive stock (web parity).
            if (orderStatus == "pending" || orderStatus == "in_hand") {
                Spacer(Modifier.height(8.dp))
                MismatchSection(item, currentUserId, actionInProgress, onReportIssue, onConfirmMismatch, onCancelMismatch)
            }
        }
    }
}

@Composable
private fun MismatchSection(
    item: ReceivingItemDetail,
    currentUserId: String?,
    actionInProgress: Boolean,
    onReportIssue: () -> Unit,
    onConfirmMismatch: (mismatchId: String) -> Unit,
    onCancelMismatch: (mismatchId: String) -> Unit,
) {
    val mismatch = item.mismatch
    when {
        item.pickedQty > 0 || item.putAwayQty > 0 -> Text(
            stringResource(R.string.common_locked),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
        mismatch != null -> {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MismatchBadge(mismatchBadgeText(mismatch), MaterialTheme.colorScheme.error)
                MismatchBadge(mismatchStatusText(mismatch.status), MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!mismatch.note.isNullOrBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    mismatch.note,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (mismatch.status == "pending") {
                // Four-eyes (mirrors ReceivingDetailViewModel.canEdit/canReviewMismatch):
                // the reporter edits; anyone else confirms/cancels.
                val canEdit = mismatch.reportedBy == currentUserId
                val canReview = mismatch.reportedBy != currentUserId
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when {
                        canEdit ->
                            OutlinedButton(onClick = onReportIssue, enabled = !actionInProgress) {
                                Text(stringResource(R.string.receiving_items_tab_edit_issue))
                            }
                        canReview -> {
                            OutlinedButton(
                                onClick = { onConfirmMismatch(mismatch.id) },
                                enabled = !actionInProgress,
                            ) {
                                Text(stringResource(R.string.receiving_items_tab_confirm_mismatch))
                            }
                            OutlinedButton(
                                onClick = { onCancelMismatch(mismatch.id) },
                                enabled = !actionInProgress,
                            ) {
                                Text(stringResource(R.string.receiving_items_tab_cancel_mismatch))
                            }
                        }
                    }
                }
            }
        }
        else -> OutlinedButton(onClick = onReportIssue, enabled = !actionInProgress) {
            Text(stringResource(R.string.receiving_items_tab_report_issue))
        }
    }
}

@Composable
private fun MismatchBadge(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        modifier = Modifier
            .clip(RoundedCornerShape(9999.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/** Port of the web ReceivingItemsTab formatMismatchSummary. */
@Composable
private fun mismatchBadgeText(m: MismatchInfo): String = when (m.reason) {
    MismatchRules.NOT_FOUND -> stringResource(R.string.receiving_items_tab_mismatch_not_found)
    MismatchRules.DAMAGED ->
        stringResource(R.string.receiving_items_tab_mismatch_damaged, m.mismatchQty ?: 0)
    MismatchRules.QUALITY_REJECTION ->
        stringResource(R.string.receiving_items_tab_mismatch_quality_rejection, m.mismatchQty ?: 0)
    MismatchRules.QTY_MISMATCH ->
        stringResource(R.string.receiving_items_tab_mismatch_qty_mismatch, m.mismatchQty ?: 0)
    MismatchRules.OVER_SHIPMENT ->
        stringResource(R.string.receiving_items_tab_mismatch_over_shipment, m.mismatchQty ?: 0)
    MismatchRules.WRONG_PART ->
        stringResource(R.string.receiving_items_tab_mismatch_wrong_part, m.wrongPartNo ?: "")
    else -> stringResource(R.string.receiving_items_tab_mismatch_reported)
}

@Composable
private fun mismatchStatusText(status: String): String = stringResource(
    when (status) {
        "pending" -> R.string.receiving_items_tab_mismatch_status_pending
        "confirmed" -> R.string.receiving_items_tab_mismatch_status_confirmed
        "cancelled" -> R.string.receiving_items_tab_mismatch_status_cancelled
        else -> R.string.receiving_items_tab_mismatch_status_pending
    }
)
