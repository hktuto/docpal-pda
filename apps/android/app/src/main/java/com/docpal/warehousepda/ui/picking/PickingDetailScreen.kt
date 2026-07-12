package com.docpal.warehousepda.ui.picking

import android.widget.Toast
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
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.docpal.warehousepda.domain.model.PickingOrderDetail
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
fun PickingDetailScreen(orderId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as App
    val viewModel: PickingDetailViewModel = viewModel(
        key = "picking-detail-$orderId",
        factory = PickingDetailViewModel.provideFactory(app.container, orderId),
    )
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus (web visibilitychange parity).
    // The VM also loads in init; the first ON_RESUME simply re-queries once.
    OnResumeEffect { viewModel.reload() }

    // Success toast after finishing creates the measuring task (web finish()).
    val measuringToast = stringResource(R.string.picking_detail_measuring_task_created)
    LaunchedEffect(state.toastKey) {
        if (state.toastKey != null) {
            Toast.makeText(context, measuringToast, Toast.LENGTH_SHORT).show()
            viewModel.clearToast()
        }
    }

    // View-only UI state (web page-level refs; screen-held like the receiving tab).
    var headerExpanded by rememberSaveable { mutableStateOf(false) }
    var boxesExpanded by rememberSaveable { mutableStateOf(false) }
    var boxSelections by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var expandedLogs by remember { mutableStateOf<Set<String>>(emptySet()) }
    var addAllCount by remember { mutableIntStateOf(0) }

    // Prune box selections to the order's current unboxed packages on reload (web load()).
    val currentDetail = state.detail
    LaunchedEffect(currentDetail) {
        if (currentDetail != null) {
            val unboxedIds = currentDetail.items
                .flatMap { it.packages }
                .filter { it.shippingBoxId == null }
                .mapTo(HashSet()) { it.id }
            boxSelections = boxSelections.filterKeys { it in unboxedIds }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.detail?.refNo ?: stringResource(R.string.picking_detail_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        },
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
                    ErrorText(state.errorKey, Modifier.align(Alignment.Center), state.errorArgs)
                }
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { Spacer(Modifier.height(8.dp)) }
                item {
                    HeaderCard(
                        detail = detail,
                        state = state,
                        expanded = headerExpanded,
                        onToggleExpanded = { headerExpanded = !headerExpanded },
                        onFinish = viewModel::finishPicking,
                    )
                }
                if (detail.status == "issue") {
                    item { IssueBannerCard(detail) }
                }
                pickingBoxesSection(
                    detail = detail,
                    expanded = boxesExpanded,
                    actionInProgress = state.actionInProgress,
                    onToggleExpanded = { boxesExpanded = !boxesExpanded },
                    onCreateBox = {
                        // Web createBox force-expands the section.
                        boxesExpanded = true
                        viewModel.createBox()
                    },
                    onAddAll = { boxId, count ->
                        addAllCount = count
                        viewModel.requestAddAll(boxId)
                    },
                    onCancelBox = viewModel::cancelBox,
                )
                pickingItemsSection(
                    detail = detail,
                    logs = state.logs,
                    boxSelections = boxSelections,
                    expandedLogs = expandedLogs,
                    actionInProgress = state.actionInProgress,
                    onSelectBox = { pkgId, boxId ->
                        boxSelections = boxSelections + (pkgId to boxId)
                    },
                    onToggleLogs = { itemId ->
                        expandedLogs =
                            if (itemId in expandedLogs) expandedLogs - itemId
                            else expandedLogs + itemId
                    },
                    onAddToBox = { pkgId ->
                        boxSelections[pkgId]?.let { viewModel.addPackageToBox(pkgId, it) }
                    },
                    onRemoveFromBox = viewModel::removePackageFromBox,
                )
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }

    // "Add all" is the only confirm-guarded picking action (web parity).
    if (state.pendingAddAllBoxId != null) {
        AlertDialog(
            onDismissRequest = viewModel::dismissAddAll,
            title = { Text(stringResource(R.string.picking_boxes_add_all)) },
            text = { Text(stringResource(R.string.picking_boxes_add_all_confirm, addAllCount)) },
            confirmButton = {
                TextButton(onClick = viewModel::confirmAddAll) {
                    Text(stringResource(R.string.picking_boxes_add_all))
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissAddAll) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

/** Web DetailHeader: refNo + status badge; body rows expand via the chevron. */
@Composable
private fun HeaderCard(
    detail: PickingOrderDetail,
    state: PickingDetailUiState,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    onFinish: () -> Unit,
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
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(detail.status, family = "picking")
                    IconButton(onClick = onToggleExpanded) {
                        Icon(
                            if (expanded) Icons.Filled.KeyboardArrowUp
                            else Icons.Filled.KeyboardArrowDown,
                            contentDescription = null,
                        )
                    }
                }
            }
            if (expanded) {
                DetailRow(
                    stringResource(R.string.picking_detail_supplier),
                    detail.supplierName ?: stringResource(R.string.common_no_supplier),
                )
                DetailRow(
                    stringResource(R.string.picking_detail_delivery_date),
                    detail.deliveryDate?.let { formatIsoDate(it) },
                )
                DetailRow(stringResource(R.string.picking_detail_po_no), detail.poNo)
                DetailRow(stringResource(R.string.picking_detail_ship_to), detail.shipTo)
                DetailRow(
                    stringResource(R.string.picking_detail_date_code_notice),
                    detail.requiredDateCodeNotice,
                )
            }
            if (state.errorKey != null) {
                Spacer(Modifier.height(4.dp))
                ErrorText(state.errorKey, args = state.errorArgs)
            }
            if (state.canFinish) {
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = onFinish,
                    enabled = !state.actionInProgress,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        stringResource(
                            if (state.actionInProgress) R.string.picking_detail_finishing
                            else R.string.picking_detail_finish_picking
                        )
                    )
                }
            }
            if (detail.status == "finished" && detail.measuringTaskId != null) {
                // The measuring flow is Phase 5 — render the task id as plain text.
                DetailRow(stringResource(R.string.picking_detail_measuring), detail.measuringTaskId)
            }
        }
    }
}

/** Web PickingIssueBanner (card--danger): issue fields + reporter. */
@Composable
private fun IssueBannerCard(detail: PickingOrderDetail) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            DetailRow(
                stringResource(R.string.picking_issue_banner_issue_reason),
                issueReasonLabel(detail.issueReason),
            )
            if (detail.issueReason == "insufficient_stock" && detail.issueQty != null) {
                DetailRow(
                    stringResource(R.string.picking_issue_banner_actual_qty_available),
                    detail.issueQty.toString(),
                )
            }
            if (detail.issueReason == "cannot_divide" && detail.issuePackSize != null) {
                DetailRow(
                    stringResource(R.string.picking_issue_banner_pack_size),
                    detail.issuePackSize.toString(),
                )
            }
            if (detail.issueRemark != null) {
                DetailRow(stringResource(R.string.picking_issue_banner_remark), detail.issueRemark)
            }
            if (detail.issueNote != null) {
                DetailRow(stringResource(R.string.picking_issue_banner_note), detail.issueNote)
            }
            DetailRow(
                stringResource(R.string.picking_issue_banner_reported),
                stringResource(
                    R.string.common_reported_by,
                    detail.issueReportedByName ?: stringResource(R.string.common_no_data),
                ),
            )
        }
    }
}

@Composable
private fun issueReasonLabel(reason: String?): String = when (reason) {
    "insufficient_stock" -> stringResource(R.string.picking_issue_reason_insufficient_stock)
    "cannot_divide" -> stringResource(R.string.picking_issue_reason_cannot_divide)
    "merge" -> stringResource(R.string.picking_issue_reason_merge)
    "other" -> stringResource(R.string.picking_issue_reason_other)
    else -> stringResource(R.string.common_no_data)
}

/** epoch ms → yyyy-MM-dd in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatIsoDate(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
