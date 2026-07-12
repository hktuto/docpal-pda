package com.docpal.warehousepda.ui.putaway

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
import com.docpal.warehousepda.domain.model.PutAwayOrderHeader
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge
import com.docpal.warehousepda.ui.components.errorMessage
import com.docpal.warehousepda.ui.receiving.rememberCameraScanLauncher
import com.docpal.warehousepda.ui.scan.LabelScanReviewDialog
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PutAwayDetailScreen(orderId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as App
    val viewModel: PutAwayDetailViewModel = viewModel(
        key = "put-away-detail-$orderId",
        factory = PutAwayDetailViewModel.provideFactory(app.container, orderId),
    )
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus (web visibilitychange parity).
    // The VM also loads in init; the first ON_RESUME simply re-queries once.
    OnResumeEffect { viewModel.reload() }

    // Camera scan → the pinned-lot scan pipeline (web openScan parity).
    val launchCameraScan = rememberCameraScanLauncher { result ->
        viewModel.onCameraScan(result)
    }

    // Toasts: scan success is a fixed string; any other toastKey is a
    // LocalizedException code from the auto-apply error path (web showToast).
    val toastText = when (state.toastKey) {
        null -> null
        "common_scan_success" -> stringResource(R.string.common_scan_success)
        else -> errorMessage(state.toastKey!!, state.toastArgs)
    }
    LaunchedEffect(toastText) {
        if (toastText != null) {
            Toast.makeText(context, toastText, Toast.LENGTH_SHORT).show()
            viewModel.clearToast()
        }
    }

    // View-only UI state (web page-level refs; screen-held like the picking detail).
    var headerExpanded by rememberSaveable { mutableStateOf(false) }
    var boxesExpanded by rememberSaveable { mutableStateOf(false) }
    var boxSelections by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var expandedLots by remember { mutableStateOf<Set<String>>(emptySet()) }
    var expandedContents by remember { mutableStateOf<Set<String>>(emptySet()) }
    var addAllCount by remember { mutableIntStateOf(0) }

    // Prune box selections to the order's current unboxed scans on reload (web load()).
    val currentDetail = state.detail
    LaunchedEffect(currentDetail) {
        if (currentDetail != null) {
            val unboxedIds = currentDetail.scans
                .filter { it.shelfBoxId == null }
                .mapTo(HashSet()) { it.id }
            boxSelections = boxSelections.filterKeys { it in unboxedIds }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.detail?.header?.refNo ?: stringResource(R.string.put_away_title)) },
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
                        header = detail.header,
                        state = state,
                        expanded = headerExpanded,
                        onToggleExpanded = { headerExpanded = !headerExpanded },
                    )
                }
                shelfBoxesSection(
                    detail = detail,
                    expanded = boxesExpanded,
                    expandedContents = expandedContents,
                    actionInProgress = state.actionInProgress,
                    unboxedCount = state.unboxedScanCount,
                    onToggleExpanded = { boxesExpanded = !boxesExpanded },
                    onToggleContents = { boxId ->
                        expandedContents =
                            if (boxId in expandedContents) expandedContents - boxId
                            else expandedContents + boxId
                    },
                    onNewBox = {
                        // Web createBox force-expands the section.
                        boxesExpanded = true
                        viewModel.openShelfDialog()
                    },
                    onAddAll = { boxId, count ->
                        addAllCount = count
                        viewModel.requestAddAll(boxId)
                    },
                    onCloseBox = viewModel::closeBox,
                    onCancelBox = viewModel::cancelBox,
                )
                putAwayLotsSection(
                    detail = detail,
                    boxSelections = boxSelections,
                    expandedLots = expandedLots,
                    actionInProgress = state.actionInProgress,
                    scanEnabled = true,
                    onSelectBox = { scanId, boxId ->
                        boxSelections = boxSelections + (scanId to boxId)
                    },
                    onToggleScans = { itemId ->
                        expandedLots =
                            if (itemId in expandedLots) expandedLots - itemId
                            else expandedLots + itemId
                    },
                    onAddToBox = { scanId ->
                        boxSelections[scanId]?.let { viewModel.assignScanToBox(scanId, it) }
                    },
                    onRemoveFromBox = viewModel::removeScanFromBox,
                    onRemoveScan = viewModel::removeScan,
                    onScanLot = { lot ->
                        // Web openScan: pin the lot, then launch the camera.
                        viewModel.pinLot(lot)
                        launchCameraScan()
                    },
                )
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }

    // "Add all" is the only confirm-guarded put-away action (web window.confirm parity).
    if (state.pendingAddAllBoxId != null) {
        AlertDialog(
            onDismissRequest = viewModel::dismissAddAll,
            title = { Text(stringResource(R.string.put_away_add_all)) },
            text = { Text(stringResource(R.string.put_away_add_all_confirm, addAllCount)) },
            confirmButton = {
                TextButton(onClick = viewModel::confirmAddAll) {
                    Text(stringResource(R.string.put_away_add_all))
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissAddAll) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    if (state.showShelfDialog) {
        SelectShelfDialog(
            shelves = state.detail?.shelves.orEmpty(),
            onConfirm = viewModel::createBox,
            onDismiss = viewModel::dismissShelfDialog,
        )
    }

    state.scanReview?.let { review ->
        LabelScanReviewDialog(
            review = review,
            onFieldsChange = viewModel::updateScanFields,
            onFindMatch = { viewModel.findMatch() },
            onApply = { viewModel.applyScan(it) },
            onRetake = {
                // Retake keeps the pin — the re-scan matches the same lot.
                viewModel.retakeScan()
                launchCameraScan()
            },
            onDismiss = viewModel::closeScanReview,
        )
    }
}

/** Web DetailHeader: refNo + status badge; body rows expand via the chevron. */
@Composable
private fun HeaderCard(
    header: PutAwayOrderHeader,
    state: PutAwayDetailUiState,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
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
                Text(header.refNo, style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(header.status, family = "receiving")
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
                    stringResource(R.string.put_away_detail_supplier),
                    header.supplierName ?: stringResource(R.string.common_no_supplier),
                )
                DetailRow(
                    stringResource(R.string.put_away_detail_delivery_date),
                    header.deliveryDate?.let { formatIsoDate(it) },
                )
            }
            if (state.errorKey != null) {
                Spacer(Modifier.height(4.dp))
                ErrorText(state.errorKey, args = state.errorArgs)
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
