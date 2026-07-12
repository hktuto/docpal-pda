package com.docpal.warehousepda.ui.receiving

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.MismatchRules
import com.docpal.warehousepda.domain.model.MismatchInfo
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ReceivingDetailScreen(orderId: String, onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: ReceivingDetailViewModel = viewModel(
        key = "receiving-detail-$orderId",
        factory = ReceivingDetailViewModel.provideFactory(app.container, orderId),
    )
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus (web visibilitychange parity).
    // The VM also loads in init; the first ON_RESUME simply re-queries once.
    OnResumeEffect { viewModel.reload() }

    // Report/edit dialog state; closes itself once a submitted action succeeds.
    var dialogItem by remember { mutableStateOf<ReceivingItemDetail?>(null) }
    var awaitingResult by remember { mutableStateOf(false) }
    LaunchedEffect(state.actionInProgress) {
        if (awaitingResult && !state.actionInProgress) {
            awaitingResult = false
            if (state.errorKey == null) dialogItem = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.detail?.refNo ?: stringResource(R.string.receiving_detail_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        }
    ) { padding ->
        val detail = state.detail
        when {
            state.loading && detail == null ->
                Box(
                    Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
            detail == null ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    ErrorText(state.errorKey, Modifier.align(Alignment.Center))
                }
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { Spacer(Modifier.height(8.dp)) }
                item { HeaderCard(detail, state, viewModel) }
                item {
                    TabRow(selectedTabIndex = state.tab) {
                        Tab(
                            selected = state.tab == 0,
                            onClick = { viewModel.setTab(0) },
                            text = { Text(stringResource(R.string.receiving_detail_tab_receiving)) },
                        )
                        Tab(
                            selected = state.tab == 1,
                            onClick = { viewModel.setTab(1) },
                            text = { Text(stringResource(R.string.receiving_detail_tab_picking)) },
                        )
                    }
                }
                if (state.tab == 0) {
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
                                viewModel = viewModel,
                                onReportIssue = { dialogItem = item },
                            )
                        }
                    }
                }
                // Tab 1 (Picking) content arrives in Task 15 — empty container by spec.
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }

    dialogItem?.let { item ->
        ReportIssueDialog(
            item = item,
            submitting = state.actionInProgress,
            errorKey = state.errorKey,
            onDismiss = { dialogItem = null },
            onConfirm = { reason, qty, wrongPart, note ->
                awaitingResult = true
                val mismatch = item.mismatch
                if (mismatch != null) {
                    viewModel.editMismatch(mismatch.id, reason, qty, wrongPart, note)
                } else {
                    viewModel.reportMismatch(item.id, reason, qty, wrongPart, note)
                }
            },
        )
    }
}

@Composable
private fun HeaderCard(
    detail: ReceivingOrderDetail,
    state: ReceivingDetailUiState,
    viewModel: ReceivingDetailViewModel,
) {
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
                Text(detail.refNo, style = MaterialTheme.typography.titleMedium)
                StatusBadge(detail.status)
            }
            Spacer(Modifier.height(8.dp))
            DetailRow(
                stringResource(R.string.receiving_detail_supplier),
                detail.supplierName ?: stringResource(R.string.common_no_supplier),
            )
            DetailRow(
                stringResource(R.string.receiving_detail_delivery_date),
                detail.deliveryDate?.let { formatIsoDate(it) },
            )
            if (detail.status == "in_hand" && detail.remainingItems > 0) {
                val itemsLabel = stringResource(
                    if (detail.remainingItems == 1) R.string.common_item else R.string.common_items
                )
                DetailRow(
                    stringResource(R.string.receiving_detail_remaining_items),
                    "${detail.remainingItems} $itemsLabel",
                )
            }
            if (state.errorKey != null) {
                Spacer(Modifier.height(4.dp))
                ErrorText(state.errorKey)
            }
            if (detail.status == "pending") {
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = viewModel::confirmArrived,
                    enabled = !state.actionInProgress,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        stringResource(
                            if (state.actionInProgress) R.string.action_confirming
                            else R.string.receiving_detail_confirm_arrived
                        )
                    )
                }
            }
            // "Put away remaining" link is Phase 3 — intentionally not rendered.
        }
    }
}

@Composable
private fun ItemCard(
    item: ReceivingItemDetail,
    orderStatus: String,
    viewModel: ReceivingDetailViewModel,
    onReportIssue: () -> Unit,
) {
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.partNo,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
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
                MismatchSection(item, viewModel, onReportIssue)
            }
        }
    }
}

@Composable
private fun MismatchSection(
    item: ReceivingItemDetail,
    viewModel: ReceivingDetailViewModel,
    onReportIssue: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
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
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when {
                        viewModel.canEditMismatch(mismatch) ->
                            OutlinedButton(onClick = onReportIssue, enabled = !state.actionInProgress) {
                                Text(stringResource(R.string.receiving_items_tab_edit_issue))
                            }
                        viewModel.canReviewMismatch(mismatch) -> {
                            OutlinedButton(
                                onClick = { viewModel.confirmMismatch(mismatch.id) },
                                enabled = !state.actionInProgress,
                            ) {
                                Text(stringResource(R.string.receiving_items_tab_confirm_mismatch))
                            }
                            OutlinedButton(
                                onClick = { viewModel.cancelMismatch(mismatch.id) },
                                enabled = !state.actionInProgress,
                            ) {
                                Text(stringResource(R.string.receiving_items_tab_cancel_mismatch))
                            }
                        }
                    }
                }
            }
        }
        else -> OutlinedButton(onClick = onReportIssue, enabled = !state.actionInProgress) {
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

/** epoch ms → yyyy-MM-dd in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatIsoDate(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
