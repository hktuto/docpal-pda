package com.docpal.warehousepda.ui.goodsverify

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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import com.docpal.warehousepda.domain.model.ShelfSummary
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect

// Same info blue the web badge--info uses (StatusBadge's in_hand color).
private val InfoBlue = Color(0xFF3B82F6)

/** Goods-verify shelf list — port of apps/web/pages/goods-verify/index.vue (search filters client-side). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoodsVerifyShelfListScreen(onShelfClick: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: GoodsVerifyShelfListViewModel = viewModel(factory = app.container.viewModelFactory)
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus, matching the web's useVisibleReload.
    // The initial ON_RESUME also covers the first load.
    OnResumeEffect { viewModel.reload() }

    // Search is screen-held and filters client-side on code/zone (web index.vue rows computed).
    var query by rememberSaveable { mutableStateOf("") }
    val term = query.trim().lowercase()
    val visible = if (term.isEmpty()) {
        state.shelves
    } else {
        state.shelves.filter {
            it.code.lowercase().contains(term) || it.zone?.lowercase()?.contains(term) == true
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.goods_verify_title)) }) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.goods_verify_search_shelves)) },
            )
            if (state.errorKey != null) {
                Spacer(Modifier.height(8.dp))
                ErrorText(state.errorKey, args = state.errorArgs)
            }
            Spacer(Modifier.height(12.dp))
            when {
                state.loading && state.shelves.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                visible.isEmpty() ->
                    EmptyState(stringResource(R.string.goods_verify_no_shelves))
                else ->
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(visible, key = { it.code }) { shelf ->
                            ShelfCard(shelf = shelf, onClick = { onShelfClick(shelf.code) })
                        }
                    }
            }
        }
    }
}

@Composable
private fun ShelfCard(shelf: ShelfSummary, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(shelf.code, style = MaterialTheme.typography.titleMedium)
                if (shelf.zone != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        shelf.zone,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            // Info pill matching the web badge--info count badge.
            Text(
                stringResource(R.string.goods_verify_boxes_count, shelf.boxCount),
                style = MaterialTheme.typography.labelSmall,
                color = InfoBlue,
                modifier = Modifier
                    .clip(RoundedCornerShape(9999.dp))
                    .background(InfoBlue.copy(alpha = 0.15f))
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
    }
}
