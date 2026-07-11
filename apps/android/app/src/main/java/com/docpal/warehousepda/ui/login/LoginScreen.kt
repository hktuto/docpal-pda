package com.docpal.warehousepda.ui.login

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.docpal.warehousepda.R
import com.docpal.warehousepda.ui.LocaleManager

@Composable
fun LoginScreen(
    onLoggedIn: () -> Unit,
    viewModel: LoginViewModel = viewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    LaunchedEffect(state.loggedInUser) {
        if (state.loggedInUser != null) onLoggedIn()
    }

    if (state.checkingSession) {
        Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CircularProgressIndicator()
        }
        return
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.login_brand), style = MaterialTheme.typography.headlineLarge)
        Text(stringResource(R.string.login_subtitle), style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(32.dp))

        OutlinedTextField(
            value = state.username,
            onValueChange = viewModel::onUsernameChange,
            label = { Text(stringResource(R.string.login_username)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = state.password,
            onValueChange = viewModel::onPasswordChange,
            label = { Text(stringResource(R.string.login_password)) },
            singleLine = true,
            visualTransformation = if (state.passwordVisible) {
                VisualTransformation.None
            } else {
                PasswordVisualTransformation()
            },
            trailingIcon = {
                IconButton(onClick = viewModel::togglePasswordVisible) {
                    Icon(
                        imageVector = if (state.passwordVisible) {
                            Icons.Filled.VisibilityOff
                        } else {
                            Icons.Filled.Visibility
                        },
                        contentDescription = stringResource(R.string.login_toggle_password),
                    )
                }
            },
            keyboardActions = KeyboardActions(onDone = { viewModel.submit() }),
            modifier = Modifier.fillMaxWidth(),
        )

        if (state.errorCode != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = when (state.errorCode) {
                    "invalid_username_or_password" -> stringResource(R.string.error_invalid_credentials)
                    else -> state.errorCode ?: ""
                },
                color = MaterialTheme.colorScheme.error,
            )
        }

        Spacer(Modifier.height(24.dp))
        Button(
            onClick = viewModel::submit,
            enabled = !state.submitting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                stringResource(
                    if (state.submitting) R.string.login_signing_in else R.string.login_sign_in
                )
            )
        }

        Spacer(Modifier.height(24.dp))
        LanguageMenu()
    }
}

@Composable
fun LanguageMenu() {
    var expanded by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val labels = mapOf(
        "en-US" to stringResource(R.string.lang_en_us),
        "zh-CN" to stringResource(R.string.lang_zh_cn),
        "zh-HK" to stringResource(R.string.lang_zh_hk),
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { expanded = true }) {
            Text(labels[LocaleManager.currentLocale(context)] ?: LocaleManager.currentLocale(context))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            LocaleManager.SUPPORTED.forEach { tag ->
                DropdownMenuItem(
                    text = { Text(labels[tag] ?: tag) },
                    onClick = {
                        expanded = false
                        LocaleManager.setLocale(context, tag)
                        (context as? Activity)?.recreate()
                    },
                )
            }
        }
    }
}
