package com.docpal.warehousepda.ui.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.docpal.warehousepda.ui.home.HomeScreen
import com.docpal.warehousepda.ui.login.LoginScreen
import com.docpal.warehousepda.ui.picking.PickingListScreen
import com.docpal.warehousepda.ui.receiving.ReceivingDetailScreen
import com.docpal.warehousepda.ui.receiving.ReceivingListScreen

object Routes {
    const val LOGIN = "login"
    const val HOME = "home"
    const val RECEIVING_LIST = "receiving"
    const val RECEIVING_DETAIL = "receiving/{orderId}"
    fun receivingDetail(orderId: String) = "receiving/$orderId"
    const val PICKING_LIST = "picking"
    const val PICKING_DETAIL = "picking/{orderId}"
    fun pickingDetail(orderId: String) = "picking/$orderId"
}

@Composable
fun AppNav() {
    val navController = rememberNavController()
    NavHost(navController = navController, startDestination = Routes.LOGIN) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onLoggedIn = {
                    navController.navigate(Routes.HOME) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                }
            )
        }
        composable(Routes.HOME) {
            HomeScreen(
                onLoggedOut = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.HOME) { inclusive = true }
                    }
                },
                onNavigate = { navController.navigate(it) },
            )
        }
        composable(Routes.RECEIVING_LIST) {
            ReceivingListScreen(
                onOrderClick = { navController.navigate(Routes.receivingDetail(it)) },
            )
        }
        composable(
            Routes.RECEIVING_DETAIL,
            arguments = listOf(navArgument("orderId") { type = NavType.StringType }),
        ) { entry ->
            val orderId = requireNotNull(entry.arguments?.getString("orderId")) { "orderId argument is required" }
            ReceivingDetailScreen(orderId = orderId, onBack = { navController.popBackStack() })
        }
        composable(Routes.PICKING_LIST) {
            PickingListScreen(
                onOrderClick = { navController.navigate(Routes.pickingDetail(it)) },
            )
        }
        composable(
            Routes.PICKING_DETAIL,
            arguments = listOf(navArgument("orderId") { type = NavType.StringType }),
        ) { entry ->
            val orderId = requireNotNull(entry.arguments?.getString("orderId")) { "orderId argument is required" }
            // Placeholder until the Task 9 picking detail screen lands.
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Picking order: $orderId")
            }
        }
    }
}
