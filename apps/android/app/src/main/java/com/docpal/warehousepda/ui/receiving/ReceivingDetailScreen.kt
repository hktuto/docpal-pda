package com.docpal.warehousepda.ui.receiving

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
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.domain.scan.HardwareKeyBuffer
import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge
import com.docpal.warehousepda.ui.scan.LabelScanReviewDialog
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceivingDetailScreen(
    orderId: String,
    onBack: () -> Unit,
    onPickingOrderClick: (pickingOrderId: String) -> Unit = {},
) {
    val context = LocalContext.current
    val app = context.applicationContext as App
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
    // The issue dialog gates the hardware wedge (scan review sets dialogOpen in the VM).
    LaunchedEffect(dialogItem != null) { viewModel.setDialogOpen(dialogItem != null) }

    // Camera scan → same handling pipeline as a hardware wedge flush.
    val launchCameraScan = rememberCameraScanLauncher { result ->
        viewModel.openScanReview(
            result.rawText,
            result.barcodes.map { OcrLabelParser.OcrBarcode(it.value, it.format) },
            result.imagePath,
        )
    }

    // Hardware scanner wedge: scanners type the code as keystrokes + Enter;
    // buffer with a 300 ms idle gap (web useHardwareScanner parity).
    val keyBuffer = remember {
        HardwareKeyBuffer(
            clock = object : HardwareKeyBuffer.Clock {
                override fun nowMillis() = System.currentTimeMillis()
            },
            onFlush = { viewModel.onHardwareScan(it) },
        )
    }
    // Dialogs live in their own windows, but also disable the buffer explicitly
    // (scan review + issue dialog raise dialogOpen; add-all confirm uses pendingAddAllBoxId).
    val wedgeDisabled = state.dialogOpen || state.pendingAddAllBoxId != null
    SideEffect { keyBuffer.enabled = !wedgeDisabled }

    // Success toast after a scan is applied.
    val scanSuccessText = stringResource(R.string.common_scan_success)
    LaunchedEffect(state.toastKey) {
        if (state.toastKey != null) {
            Toast.makeText(context, scanSuccessText, Toast.LENGTH_SHORT).show()
            viewModel.clearToast()
        }
    }

    // Picking tab UI state (selections/toggles are view-only, survive recomposition).
    var boxSelections by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var expandedLogs by remember { mutableStateOf<Set<String>>(emptySet()) }
    var addAllCount by remember { mutableIntStateOf(0) }

    Scaffold(
        modifier = Modifier.onPreviewKeyEvent { event ->
            when {
                wedgeDisabled || event.type != KeyEventType.KeyDown -> false
                event.key == Key.Enter ->
                    keyBuffer.onKey("Enter") == HardwareKeyBuffer.Consume.CONSUMED
                else -> {
                    val codePoint = event.utf16CodePoint
                    if (codePoint != 0 && !codePoint.toChar().isISOControl()) {
                        keyBuffer.onKey(codePoint.toChar().toString()) ==
                            HardwareKeyBuffer.Consume.CONSUMED
                    } else false
                }
            }
        },
        topBar = {
            TopAppBar(
                title = { Text(state.detail?.refNo ?: stringResource(R.string.receiving_detail_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        },
        floatingActionButton = {
            // ScanFab parity: only on the Picking tab. FAB opens the camera;
            // the secondary text button opens the review dialog in manual mode.
            if (state.tab == 1 && state.detail != null) {
                Column(horizontalAlignment = Alignment.End) {
                    TextButton(onClick = { viewModel.openManualEntry() }) {
                        Text(stringResource(R.string.scan_review_title_manual))
                    }
                    FloatingActionButton(
                        onClick = {
                            viewModel.pinScan(null)
                            launchCameraScan()
                        }
                    ) {
                        Icon(
                            Icons.Filled.QrCodeScanner,
                            contentDescription = stringResource(R.string.receiving_picking_tab_scan),
                        )
                    }
                }
            }
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
                } else {
                    receivingPickingTabContent(
                        detail = detail,
                        actionInProgress = state.actionInProgress,
                        boxSelections = boxSelections,
                        expandedLogs = expandedLogs,
                        onPickingOrderClick = onPickingOrderClick,
                        onSelectBox = { pkgId, boxId ->
                            boxSelections = boxSelections + (pkgId to boxId)
                        },
                        onToggleLogs = { itemId ->
                            expandedLogs =
                                if (itemId in expandedLogs) expandedLogs - itemId
                                else expandedLogs + itemId
                        },
                        onCreateBox = viewModel::createBox,
                        onAddAll = { boxId, count ->
                            addAllCount = count
                            viewModel.requestAddAll(boxId)
                        },
                        onAddToBox = { pkgId ->
                            boxSelections[pkgId]?.let { viewModel.addPackageToBox(pkgId, it) }
                        },
                        onRemoveFromBox = viewModel::removePackageFromBox,
                        onRemoveScan = viewModel::removeScannedPackage,
                        onScanItem = { itemId ->
                            viewModel.pinScan(itemId)
                            launchCameraScan()
                        },
                    )
                }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }

    dialogItem?.let { item ->
        ReportIssueDialog(
            item = item,
            submitting = state.actionInProgress,
            errorKey = state.errorKey,
            errorArgs = state.errorArgs,
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

    // "Add all" is the only confirm-guarded picking action (web parity).
    if (state.pendingAddAllBoxId != null) {
        AlertDialog(
            onDismissRequest = viewModel::dismissAddAll,
            title = { Text(stringResource(R.string.receiving_picking_tab_add_all)) },
            text = {
                Text(stringResource(R.string.receiving_picking_tab_add_all_confirm, addAllCount))
            },
            confirmButton = {
                TextButton(onClick = viewModel::confirmAddAll) {
                    Text(stringResource(R.string.receiving_picking_tab_add_all))
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissAddAll) {
                    Text(stringResource(R.string.scan_review_cancel))
                }
            },
        )
    }

    state.scanReview?.let { review ->
        LabelScanReviewDialog(
            review = review,
            onFieldsChange = viewModel::updateScanFields,
            onFindMatch = { viewModel.findMatch() },
            onApply = { viewModel.applyScan(it) },
            onRetake = {
                viewModel.closeScanReview()
                launchCameraScan()
            },
            onDismiss = viewModel::closeScanReview,
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
                ErrorText(state.errorKey, args = state.errorArgs)
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
