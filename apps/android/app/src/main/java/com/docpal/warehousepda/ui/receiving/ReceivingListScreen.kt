package com.docpal.warehousepda.ui.receiving

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.ReceivingOrderSummary
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.components.StatusBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceivingListScreen(onOrderClick: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: ReceivingListViewModel = viewModel(factory = app.container.viewModelFactory)
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Reload whenever the screen regains focus, matching the web's visibilitychange reload.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.reload()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val filters = listOf(
        R.string.common_all to "all",
        R.string.status_receiving_pending to "pending",
        R.string.status_receiving_in_hand to "in_hand",
        R.string.status_receiving_clear to "clear",
    )

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.receiving_title)) }) }
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
        ) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(filters) { (labelRes, value) ->
                    FilterChip(
                        selected = state.filter == value,
                        onClick = { viewModel.setFilter(value) },
                        label = { Text(stringResource(labelRes)) },
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = state.search,
                onValueChange = viewModel::setSearch,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.common_search_by_ref_or_supplier)) },
            )
            Spacer(Modifier.height(12.dp))
            when {
                state.loading && state.orders.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                state.visibleOrders.isEmpty() ->
                    EmptyState(stringResource(R.string.common_no_receiving_orders))
                else ->
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(state.visibleOrders, key = { it.id }) { order ->
                            ReceivingOrderCard(order, onClick = { onOrderClick(order.id) })
                        }
                    }
            }
        }
    }
}

@Composable
private fun ReceivingOrderCard(order: ReceivingOrderSummary, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(order.refNo, style = MaterialTheme.typography.titleMedium)
                StatusBadge(order.status)
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
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (order.status == "in_hand" && order.remainingItems > 0) {
                        InfoBadge(stringResource(R.string.receiving_remaining, order.remainingItems))
                    }
                    if (order.pendingPickingOrders > 0) {
                        InfoBadge(
                            "${order.pendingPickingOrders} ${stringResource(R.string.status_picking_picking)}"
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun InfoBadge(text: String) {
    val color = MaterialTheme.colorScheme.primary
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        modifier = Modifier
            .background(
                color.copy(alpha = 0.12f),
                androidx.compose.foundation.shape.RoundedCornerShape(9999.dp),
            )
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/** epoch ms → yyyy-MM-dd in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatIsoDate(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
