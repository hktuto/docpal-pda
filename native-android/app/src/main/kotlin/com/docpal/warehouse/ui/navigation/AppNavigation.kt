package com.docpal.warehouse.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.docpal.warehouse.ui.screens.HomeScreen
import com.docpal.warehouse.ui.screens.LoginScreen
import com.docpal.warehouse.ui.screens.MeasuringBoxDetailScreen
import com.docpal.warehouse.ui.screens.MeasuringListScreen
import com.docpal.warehouse.ui.screens.MeasuringTaskDetailScreen
import com.docpal.warehouse.ui.screens.StockSearchScreen

object Routes {
    const val LOGIN = "login"
    const val HOME = "home"
    const val STOCK_SEARCH = "stock_search"
    const val MEASURING_LIST = "measuring_list"
    const val MEASURING_TASK_DETAIL = "measuring_task_detail"
    const val MEASURING_BOX_DETAIL = "measuring_box_detail"
}

object RouteArgs {
    const val TASK_ID = "taskId"
    const val BOX_ID = "boxId"
}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = Routes.LOGIN) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate(Routes.HOME) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                }
            )
        }
        composable(Routes.HOME) {
            HomeScreen(
                onStockSearch = { navController.navigate(Routes.STOCK_SEARCH) },
                onMeasuring = { navController.navigate(Routes.MEASURING_LIST) }
            )
        }
        composable(Routes.STOCK_SEARCH) {
            StockSearchScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.MEASURING_LIST) {
            MeasuringListScreen(
                onBack = { navController.popBackStack() },
                onTaskClick = { taskId ->
                    navController.navigate("${Routes.MEASURING_TASK_DETAIL}/$taskId")
                }
            )
        }
        composable(
            route = "${Routes.MEASURING_TASK_DETAIL}/{${RouteArgs.TASK_ID}}",
            arguments = listOf(navArgument(RouteArgs.TASK_ID) { type = NavType.StringType })
        ) { backStackEntry ->
            val taskId = backStackEntry.arguments?.getString(RouteArgs.TASK_ID) ?: ""
            MeasuringTaskDetailScreen(
                taskId = taskId,
                onBack = { navController.popBackStack() },
                onBoxClick = { boxId ->
                    navController.navigate("${Routes.MEASURING_BOX_DETAIL}/$boxId")
                }
            )
        }
        composable(
            route = "${Routes.MEASURING_BOX_DETAIL}/{${RouteArgs.BOX_ID}}",
            arguments = listOf(navArgument(RouteArgs.BOX_ID) { type = NavType.StringType })
        ) { backStackEntry ->
            val boxId = backStackEntry.arguments?.getString(RouteArgs.BOX_ID) ?: ""
            MeasuringBoxDetailScreen(
                boxId = boxId,
                onBack = { navController.popBackStack() }
            )
        }
    }
}
