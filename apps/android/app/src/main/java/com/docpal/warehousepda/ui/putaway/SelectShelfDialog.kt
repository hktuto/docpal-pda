package com.docpal.warehousepda.ui.putaway

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.ShelfOption

/**
 * Select-shelf dialog — port of the web SelectShelfDialog.vue as an AlertDialog.
 * Confirm is disabled until a shelf is chosen, then reports the shelf code
 * (the ViewModel creates the box). The selected shelf resets on every open,
 * like the web's watch on modelValue.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SelectShelfDialog(
    shelves: List<ShelfOption>,
    onConfirm: (shelfCode: String) -> Unit,
    onDismiss: () -> Unit,
) {
    var selected by remember { mutableStateOf<String?>(null) }
    var expanded by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.select_shelf_title)) },
        text = {
            ExposedDropdownMenuBox(
                expanded = expanded,
                onExpandedChange = { expanded = it },
            ) {
                OutlinedTextField(
                    value = shelves.firstOrNull { it.code == selected }?.let { shelfLabel(it) } ?: "",
                    onValueChange = {},
                    readOnly = true,
                    singleLine = true,
                    label = { Text(stringResource(R.string.select_shelf_label)) },
                    placeholder = { Text(stringResource(R.string.select_shelf_default)) },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                    modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable),
                )
                ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    for (shelf in shelves) {
                        DropdownMenuItem(
                            text = { Text(shelfLabel(shelf)) },
                            onClick = {
                                selected = shelf.code
                                expanded = false
                            },
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { selected?.let(onConfirm) },
                enabled = selected != null,
            ) {
                Text(stringResource(R.string.put_away_new_box))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

/** Web shelfLabel: "{code} — {zone}" when a zone exists, else the bare code. */
@Composable
private fun shelfLabel(shelf: ShelfOption): String =
    shelf.zone?.let { stringResource(R.string.common_shelf_format, shelf.code, it) } ?: shelf.code
