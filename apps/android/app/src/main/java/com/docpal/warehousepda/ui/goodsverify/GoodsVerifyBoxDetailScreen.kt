package com.docpal.warehousepda.ui.goodsverify

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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge
import com.docpal.warehousepda.ui.receiving.rememberCameraScanLauncher
import com.docpal.warehousepda.ui.scan.LabelScanReviewDialog

/** Goods-verify box detail — port of apps/web/pages/goods-verify/box/[id].vue. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoodsVerifyBoxDetailScreen(boxId: String, onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: GoodsVerifyBoxDetailViewModel = viewModel(
        key = "goods-verify-box-$boxId",
        factory = GoodsVerifyBoxDetailViewModel.provideFactory(app.container, boxId),
    )
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus (web useVisibleReload parity).
    // The VM also loads in init; the first ON_RESUME simply re-queries once.
    OnResumeEffect { viewModel.reload() }

    // Camera scan → the box-level scan-to-verify pipeline (web openScan parity).
    // Every per-item Scan button triggers the same launch (no per-item pin).
    val launchCameraScan = rememberCameraScanLauncher { result ->
        viewModel.onCameraScan(result)
    }

    // View-only UI state (web headerExpanded ref).
    var headerExpanded by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.goods_verify_box_title, boxId)) },
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
                    EmptyState(stringResource(R.string.goods_verify_box_not_found))
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
                        onMarkVerified = viewModel::markVerified,
                    )
                }
                goodsVerifyItemsSection(
                    detail = detail,
                    actionInProgress = state.actionInProgress,
                    scanEnabled = true,
                    onScan = launchCameraScan,
                )
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }

    state.scanReview?.let { review ->
        LabelScanReviewDialog(
            review = review,
            onFieldsChange = viewModel::updateScanFields,
            onFindMatch = { viewModel.findMatch() },
            onApply = { viewModel.applyScan(it) },
            onRetake = {
                viewModel.retakeScan()
                launchCameraScan()
            },
            onDismiss = viewModel::closeScanReview,
        )
    }
}

/** Web DetailHeader: box id + status badge; the shelf row expands via the chevron. */
@Composable
private fun HeaderCard(
    detail: VerifyBoxDetail,
    state: GoodsVerifyBoxDetailUiState,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    onMarkVerified: () -> Unit,
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
                Text(
                    stringResource(R.string.goods_verify_box_title, detail.id),
                    style = MaterialTheme.typography.titleMedium,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(detail.status, family = "box")
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
                // Shelf can be null after a cancelled shelf assignment
                // (DetailRow renders common_no_data for null).
                DetailRow(stringResource(R.string.goods_verify_shelf_label), detail.shelfCode)
            }
            if (state.errorKey != null) {
                Spacer(Modifier.height(4.dp))
                ErrorText(state.errorKey, args = state.errorArgs)
            }
            if (state.canMarkVerified) {
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = onMarkVerified,
                    enabled = !state.actionInProgress,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.goods_verify_mark_verified))
                }
            }
        }
    }
}
