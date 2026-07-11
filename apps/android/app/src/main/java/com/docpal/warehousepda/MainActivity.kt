package com.docpal.warehousepda

import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.docpal.warehousepda.ui.LocaleManager
import com.docpal.warehousepda.ui.navigation.AppNav
import com.docpal.warehousepda.ui.theme.WarehousePdaTheme
import java.util.Locale

class MainActivity : ComponentActivity() {

    override fun attachBaseContext(newBase: Context) {
        val config = Configuration(newBase.resources.configuration)
        config.setLocale(Locale.forLanguageTag(LocaleManager.currentLocale(newBase)))
        super.attachBaseContext(newBase.createConfigurationContext(config))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            WarehousePdaTheme {
                AppNav()
            }
        }
    }
}
