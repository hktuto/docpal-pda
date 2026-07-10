package com.docpal.warehouse.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehouse.R

private data class MenuItem(
    val labelRes: Int
)

private val menuItems = listOf(
    MenuItem(R.string.receiving),
    MenuItem(R.string.picking),
    MenuItem(R.string.put_away),
    MenuItem(R.string.measuring),
    MenuItem(R.string.goods_verify),
    MenuItem(R.string.stock_search)
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onStockSearch: () -> Unit,
    onMeasuring: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(title = { Text(stringResource(R.string.home_title)) })
        }
    ) { paddingValues ->
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(menuItems) { item ->
                val onClick: () -> Unit = {
                    when (item.labelRes) {
                        R.string.stock_search -> onStockSearch()
                        R.string.measuring -> onMeasuring()
                        else -> { /* TODO in next phases */ }
                    }
                }
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClick = onClick)
                ) {
                    Text(
                        text = stringResource(item.labelRes),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(24.dp)
                    )
                }
            }
        }
    }
}
