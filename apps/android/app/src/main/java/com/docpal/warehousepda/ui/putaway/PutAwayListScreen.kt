package com.docpal.warehousepda.ui.putaway

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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.PutAwayCandidate
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.ErrorText
import com.docpal.warehousepda.ui.components.OnResumeEffect
import com.docpal.warehousepda.ui.components.StatusBadge

/** Put-away list — port of apps/web/pages/put-away/index.vue (no search, no filters). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PutAwayListScreen(onOrderClick: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: PutAwayListViewModel = viewModel(factory = app.container.viewModelFactory)
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus, matching the web's useVisibleReload.
    // The initial ON_RESUME also covers the first load.
    OnResumeEffect { viewModel.reload() }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.put_away_title)) }) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
        ) {
            Text(
                stringResource(R.string.put_away_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (state.errorKey != null) {
                Spacer(Modifier.height(8.dp))
                ErrorText(state.errorKey, args = state.errorArgs)
            }
            Spacer(Modifier.height(12.dp))
            when {
                state.loading && state.orders.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                state.orders.isEmpty() ->
                    EmptyState(stringResource(R.string.common_no_receiving_orders_need_put_away))
                else ->
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(state.orders, key = { it.orderId }) { order ->
                            PutAwayCandidateCard(order = order, onClick = { onOrderClick(order.orderId) })
                        }
                    }
            }
        }
    }
}

@Composable
private fun PutAwayCandidateCard(order: PutAwayCandidate, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    order.refNo,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                StatusBadge(order.status, family = "receiving")
            }
            Spacer(Modifier.height(4.dp))
            Text(
                order.supplierName ?: stringResource(R.string.common_no_supplier),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.put_away_available, order.availableQty),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
