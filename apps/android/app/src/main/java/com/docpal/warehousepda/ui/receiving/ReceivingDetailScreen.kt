package com.docpal.warehousepda.ui.receiving

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
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
                    receivingItemsTabContent(
                        detail = detail,
                        currentUserId = state.currentUserId,
                        actionInProgress = state.actionInProgress,
                        onReportIssue = { item ->
                            viewModel.clearError()
                            dialogItem = item
                        },
                        onConfirmMismatch = viewModel::confirmMismatch,
                        onCancelMismatch = viewModel::cancelMismatch,
                    )
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
            onDismiss = {
                viewModel.clearError()
                dialogItem = null
            },
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

/** epoch ms → yyyy-MM-dd in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatIsoDate(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
