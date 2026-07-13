package com.docpal.warehousepda.ui.home

import android.app.Activity
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.App
import com.docpal.warehousepda.R
import com.docpal.warehousepda.ui.LocaleManager
import com.docpal.warehousepda.ui.navigation.Routes

private data class MenuCard(
    val titleRes: Int,
    val descRes: Int,
    val color: Color,
    val route: String? = null,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onLoggedOut: () -> Unit,
    onNavigate: (String) -> Unit = {},
) {
    val app = LocalContext.current.applicationContext as App
    val viewModel: HomeViewModel = viewModel(factory = app.container.viewModelFactory)
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(state.loggedOut) {
        if (state.loggedOut) onLoggedOut()
    }

    if (state.loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val cards = listOf(
        MenuCard(R.string.menu_receiving_title, R.string.menu_receiving_desc, Color(0xFF00BFA5), Routes.RECEIVING_LIST),
        MenuCard(R.string.menu_picking_title, R.string.menu_picking_desc, Color(0xFF3B82F6), Routes.PICKING_LIST),
        MenuCard(R.string.menu_put_away_title, R.string.menu_put_away_desc, Color(0xFFF59E0B), Routes.PUT_AWAY_LIST),
        MenuCard(R.string.menu_goods_verify_title, R.string.menu_goods_verify_desc, Color(0xFF10B981), Routes.GOODS_VERIFY_SHELVES),
        MenuCard(R.string.menu_measuring_title, R.string.menu_measuring_desc, Color(0xFF8B5CF6)),
        MenuCard(R.string.menu_stock_search_title, R.string.menu_stock_search_desc, Color(0xFFEC4899)),
    )

    var menuExpanded by remember { mutableStateOf(false) }
    val comingSoon = stringResource(R.string.common_coming_soon)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_name)) },
                actions = {
                    IconButton(onClick = { menuExpanded = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = null)
                    }
                    DropdownMenu(
                        expanded = menuExpanded,
                        onDismissRequest = { menuExpanded = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.lang_en_us)) },
                            onClick = {
                                menuExpanded = false
                                LocaleManager.setLocale(context, "en-US")
                                (context as? Activity)?.recreate()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.lang_zh_cn)) },
                            onClick = {
                                menuExpanded = false
                                LocaleManager.setLocale(context, "zh-CN")
                                (context as? Activity)?.recreate()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.lang_zh_hk)) },
                            onClick = {
                                menuExpanded = false
                                LocaleManager.setLocale(context, "zh-HK")
                                (context as? Activity)?.recreate()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.action_logout)) },
                            onClick = { menuExpanded = false; viewModel.logout() },
                        )
                    }
                },
            )
        }
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
        ) {
            val name = state.user?.displayName ?: stringResource(R.string.home_operator_fallback)
            Text(
                stringResource(R.string.home_greeting, name),
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                stringResource(R.string.home_prompt),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(bottom = 16.dp),
            ) {
                items(cards) { card ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                val route = card.route
                                if (route != null) {
                                    onNavigate(route)
                                } else {
                                    Toast.makeText(context, comingSoon, Toast.LENGTH_SHORT).show()
                                }
                            },
                        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
                    ) {
                        Row(
                            Modifier.padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier
                                    .size(40.dp)
                                    .background(card.color, RoundedCornerShape(10.dp))
                            )
                            Column(Modifier.padding(start = 12.dp)) {
                                Text(
                                    stringResource(card.titleRes),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Text(
                                    stringResource(card.descRes),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
