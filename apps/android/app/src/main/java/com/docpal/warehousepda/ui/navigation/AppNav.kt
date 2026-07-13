package com.docpal.warehousepda.ui.navigation

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.docpal.warehousepda.ui.goodsverify.GoodsVerifyBoxListScreen
import com.docpal.warehousepda.ui.goodsverify.GoodsVerifyShelfListScreen
import com.docpal.warehousepda.ui.home.HomeScreen
import com.docpal.warehousepda.ui.login.LoginScreen
import com.docpal.warehousepda.ui.picking.PickingDetailScreen
import com.docpal.warehousepda.ui.picking.PickingListScreen
import com.docpal.warehousepda.ui.putaway.PutAwayDetailScreen
import com.docpal.warehousepda.ui.putaway.PutAwayListScreen
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
    const val PUT_AWAY_LIST = "put-away"
    const val PUT_AWAY_DETAIL = "put-away/{orderId}"
    fun putAwayDetail(orderId: String) = "put-away/$orderId"
    const val GOODS_VERIFY_SHELVES = "goods-verify"
    const val GOODS_VERIFY_SHELF_BOXES = "goods-verify/shelf/{shelfCode}"
    const val GOODS_VERIFY_BOX = "goods-verify/box/{boxId}"
    fun goodsVerifyShelfBoxes(shelfCode: String) = "goods-verify/shelf/$shelfCode"
    fun goodsVerifyBox(boxId: String) = "goods-verify/box/$boxId"
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
            ReceivingDetailScreen(
                orderId = orderId,
                onBack = { navController.popBackStack() },
                onPickingOrderClick = { navController.navigate(Routes.pickingDetail(it)) },
            )
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
            PickingDetailScreen(orderId = orderId, onBack = { navController.popBackStack() })
        }
        composable(Routes.PUT_AWAY_LIST) {
            PutAwayListScreen(
                onOrderClick = { navController.navigate(Routes.putAwayDetail(it)) },
            )
        }
        composable(
            Routes.PUT_AWAY_DETAIL,
            arguments = listOf(navArgument("orderId") { type = NavType.StringType }),
        ) { entry ->
            val orderId = requireNotNull(entry.arguments?.getString("orderId")) { "orderId argument is required" }
            PutAwayDetailScreen(orderId = orderId, onBack = { navController.popBackStack() })
        }
        composable(Routes.GOODS_VERIFY_SHELVES) {
            GoodsVerifyShelfListScreen(
                onShelfClick = { navController.navigate(Routes.goodsVerifyShelfBoxes(it)) },
            )
        }
        composable(
            Routes.GOODS_VERIFY_SHELF_BOXES,
            arguments = listOf(navArgument("shelfCode") { type = NavType.StringType }),
        ) { entry ->
            val shelfCode = requireNotNull(entry.arguments?.getString("shelfCode")) { "shelfCode argument is required" }
            GoodsVerifyBoxListScreen(
                shelfCode = shelfCode,
                onBack = { navController.popBackStack() },
                onBoxClick = { navController.navigate(Routes.goodsVerifyBox(it)) },
            )
        }
        composable(
            Routes.GOODS_VERIFY_BOX,
            arguments = listOf(navArgument("boxId") { type = NavType.StringType }),
        ) { entry ->
            val boxId = requireNotNull(entry.arguments?.getString("boxId")) { "boxId argument is required" }
            // Placeholder — the real box detail lands in Task 7.
            Text("goods-verify/box/$boxId")
        }
    }
}
