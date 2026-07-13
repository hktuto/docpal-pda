package com.docpal.warehousepda.ui.goodsverify

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.VerifyBoxSummary
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge
import com.docpal.warehousepda.ui.picking.CardDoneColor
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Web "Today" pill colors (badge background #dcfce7 / text #166534).
private val TodayPillBg = Color(0xFFDCFCE7)
private val TodayGreen = Color(0xFF166534)

/** Goods-verify boxes-on-one-shelf list — port of apps/web/pages/goods-verify/shelf/[code].vue (search filters client-side). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoodsVerifyBoxListScreen(
    shelfCode: String,
    onBack: () -> Unit,
    onBoxClick: (String) -> Unit,
) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: GoodsVerifyBoxListViewModel = viewModel(
        key = "goods-verify-boxes-$shelfCode",
        factory = GoodsVerifyBoxListViewModel.provideFactory(app.container, shelfCode),
    )
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus, matching the web's useVisibleReload.
    // The initial ON_RESUME also covers the first load.
    OnResumeEffect { viewModel.reload() }

    // Search is screen-held and filters client-side on id/status (web [code].vue filteredBoxes).
    var query by rememberSaveable { mutableStateOf("") }
    val term = query.trim().lowercase()
    val visible = if (term.isEmpty()) {
        state.boxes
    } else {
        state.boxes.filter {
            it.id.lowercase().contains(term) || it.status.lowercase().contains(term)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.goods_verify_boxes_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
        ) {
            Text(
                stringResource(R.string.goods_verify_boxes_intro, shelfCode),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.goods_verify_search_boxes)) },
            )
            if (state.errorKey != null) {
                Spacer(Modifier.height(8.dp))
                ErrorText(state.errorKey, args = state.errorArgs)
            }
            Spacer(Modifier.height(12.dp))
            when {
                state.loading && state.boxes.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                visible.isEmpty() ->
                    EmptyState(stringResource(R.string.goods_verify_no_boxes))
                else ->
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(visible, key = { it.id }) { box ->
                            BoxCard(box = box, onClick = { onBoxClick(box.id) })
                        }
                    }
            }
        }
    }
}

/** Web shelf page card: id + verified fraction + status badge + last check, done border when verified. */
@Composable
private fun BoxCard(box: VerifyBoxSummary, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        border = if (box.status == "verified") BorderStroke(1.dp, CardDoneColor) else null,
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f)) {
                Text(box.id, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(4.dp))
                Text(
                    stringResource(
                        R.string.goods_verify_verified_fraction,
                        box.verifiedCount,
                        box.itemCount,
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (box.lastCheckAt != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        stringResource(R.string.goods_verify_last_check, formatDateTime(box.lastCheckAt)),
                        style = MaterialTheme.typography.bodyMedium,
                        // Web tints the last-check line green when the box was checked today.
                        color = if (box.checkedToday) TodayGreen else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                StatusBadge(box.status, family = "box")
                if (box.checkedToday) {
                    Spacer(Modifier.height(4.dp))
                    // Inline "Today" pill — same shape as the shelf list's count pill, web's green tone.
                    Text(
                        stringResource(R.string.common_today),
                        style = MaterialTheme.typography.labelSmall,
                        color = TodayGreen,
                        modifier = Modifier
                            .clip(RoundedCornerShape(9999.dp))
                            .background(TodayPillBg)
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
        }
    }
}

/** epoch ms → yyyy-MM-dd HH:mm in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatDateTime(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
