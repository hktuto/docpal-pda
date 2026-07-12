package com.docpal.warehousepda.ui.picking

import android.widget.Toast
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.PickingOrderSummary
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Picking list — port of apps/web/pages/picking/index.vue (search, multi-select, batch issue report). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickingListScreen(onOrderClick: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: PickingListViewModel = viewModel(factory = app.container.viewModelFactory)
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // Reload whenever the screen regains focus, matching the web's useVisibleReload.
    // The initial ON_RESUME also covers the first load.
    OnResumeEffect { viewModel.reload() }

    // Summary toast after a successful batch report (web reportMessage).
    LaunchedEffect(state.toastKey) {
        if (state.toastKey == "issue_reported" && state.toastArgs.size == 2) {
            Toast.makeText(
                context,
                context.getString(
                    R.string.picking_issue_report_summary,
                    state.toastArgs[0],
                    state.toastArgs[1],
                ),
                Toast.LENGTH_LONG,
            ).show()
            viewModel.clearToast()
        }
    }

    // Report dialog state; closes itself once a submitted report succeeds
    // (same awaitingResult pattern as the receiving mismatch dialog).
    var dialogOpen by remember { mutableStateOf(false) }
    var awaitingResult by remember { mutableStateOf(false) }
    LaunchedEffect(state.reporting) {
        if (awaitingResult && !state.reporting) {
            awaitingResult = false
            if (state.errorKey == null) dialogOpen = false
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.picking_title)) }) },
        bottomBar = {
            if (state.selectedIds.isNotEmpty()) {
                Surface(shadowElevation = 8.dp) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(R.string.common_selected_count, state.selectedIds.size),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Button(
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.error,
                            ),
                            onClick = { dialogOpen = true },
                        ) {
                            Text(stringResource(R.string.picking_report_issue))
                        }
                    }
                }
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
        ) {
            OutlinedTextField(
                value = state.search,
                onValueChange = viewModel::setSearch,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.common_search_by_ref_or_supplier)) },
            )
            // Report errors are shown inline in the dialog while it is open; once
            // dismissed (which clears the error) nothing is duplicated here.
            if (state.errorKey != null && !dialogOpen) {
                Spacer(Modifier.height(8.dp))
                ErrorText(state.errorKey, args = state.errorArgs)
            }
            Spacer(Modifier.height(12.dp))
            when {
                state.loading && state.orders.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                state.visibleOrders.isEmpty() ->
                    EmptyState(stringResource(R.string.common_no_picking_orders))
                else ->
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(state.visibleOrders, key = { it.id }) { order ->
                            PickingOrderCard(
                                order = order,
                                selected = order.id in state.selectedIds,
                                onToggleSelection = { viewModel.toggleSelection(order.id) },
                                onOrderClick = { onOrderClick(order.id) },
                            )
                        }
                    }
            }
        }
    }

    if (dialogOpen) {
        PickingIssueReportDialog(
            orders = state.selectedOrders,
            submitting = state.reporting,
            errorKey = state.errorKey,
            errorArgs = state.errorArgs,
            onDismiss = {
                viewModel.clearError()
                dialogOpen = false
            },
            onConfirm = { reason, qty, packSize, note, remarks ->
                awaitingResult = true
                viewModel.reportIssues(reason, qty, packSize, note, remarks)
            },
        )
    }
}

@Composable
private fun PickingOrderCard(
    order: PickingOrderSummary,
    selected: Boolean,
    onToggleSelection: () -> Unit,
    onOrderClick: () -> Unit,
) {
    // Only pending/picking orders can be selected (web isSelectable); others are dimmed.
    val selectable = order.status == "pending" || order.status == "picking"
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (selectable) Modifier else Modifier.alpha(0.65f)),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (selectable) {
                    Checkbox(checked = selected, onCheckedChange = { onToggleSelection() })
                }
                Text(
                    order.refNo,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier
                        .weight(1f)
                        .clickable(onClick = onOrderClick)
                        .padding(vertical = 8.dp),
                )
                StatusBadge(order.status, family = "picking")
            }
            Spacer(Modifier.height(4.dp))
            Text(
                order.supplierName ?: stringResource(R.string.common_no_supplier),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    order.deliveryDate?.let { formatIsoDate(it) } ?: stringResource(R.string.common_no_date),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    stringResource(
                        R.string.picking_ship_to,
                        order.shipTo ?: stringResource(R.string.common_no_data),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** epoch ms → yyyy-MM-dd in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatIsoDate(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
