package com.docpal.warehousepda.ui.receiving

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.MismatchRules
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.ui.components.ErrorText

/**
 * Report/edit mismatch dialog — port of the web ReportIssueModal.
 * Validates client-side with [MismatchRules] (same rules as the web modal) and
 * surfaces repository errors via [errorKey] while open ([errorArgs] are its
 * `%1$s` format args). [submitting] disables inputs.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportIssueDialog(
    item: ReceivingItemDetail,
    submitting: Boolean,
    errorKey: String?,
    errorArgs: List<String> = emptyList(),
    onDismiss: () -> Unit,
    onConfirm: (reason: String, qty: Int?, wrongPartNo: String?, note: String) -> Unit,
) {
    val editing = item.mismatch
    var reason by remember(item.id) { mutableStateOf(editing?.reason) }
    var qtyText by remember(item.id) { mutableStateOf(editing?.mismatchQty?.toString() ?: "") }
    var wrongPartNo by remember(item.id) { mutableStateOf(editing?.wrongPartNo ?: "") }
    var note by remember(item.id) { mutableStateOf(editing?.note ?: "") }
    var validationError by remember(item.id) { mutableStateOf<String?>(null) }
    var reasonExpanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        title = {
            Text(stringResource(if (editing != null) R.string.issue_title_edit else R.string.issue_title_report))
        },
        text = {
            Column {
                ExposedDropdownMenuBox(
                    expanded = reasonExpanded,
                    onExpandedChange = { if (!submitting) reasonExpanded = it },
                ) {
                    OutlinedTextField(
                        value = reason?.let { reasonLabel(it) } ?: "",
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(stringResource(R.string.issue_reason)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = reasonExpanded) },
                        modifier = Modifier
                            .menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled = !submitting)
                            .fillMaxWidth(),
                    )
                    ExposedDropdownMenu(
                        expanded = reasonExpanded,
                        onDismissRequest = { reasonExpanded = false },
                    ) {
                        MismatchRules.ALL_REASONS.forEach { r ->
                            DropdownMenuItem(
                                text = { Text(reasonLabel(r)) },
                                onClick = {
                                    reason = r
                                    // Fields from a previous reason don't carry over.
                                    qtyText = ""
                                    wrongPartNo = ""
                                    validationError = null
                                    reasonExpanded = false
                                },
                            )
                        }
                    }
                }

                reason?.let { selected ->
                    if (selected != MismatchRules.NOT_FOUND) {
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = qtyText,
                            onValueChange = { qtyText = it.filter { c -> c.isDigit() }; validationError = null },
                            label = { Text(stringResource(qtyLabelRes(selected))) },
                            placeholder = { Text(stringResource(qtyPlaceholderRes(selected))) },
                            singleLine = true,
                            enabled = !submitting,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                if (reason == MismatchRules.WRONG_PART) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = wrongPartNo,
                        onValueChange = { wrongPartNo = it; validationError = null },
                        label = { Text(stringResource(R.string.issue_wrong_part_number)) },
                        placeholder = { Text(stringResource(R.string.issue_placeholder_scan_or_type)) },
                        singleLine = true,
                        enabled = !submitting,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.issue_note)) },
                    placeholder = { Text(stringResource(R.string.issue_placeholder_note)) },
                    singleLine = true,
                    enabled = !submitting,
                    modifier = Modifier.fillMaxWidth(),
                )

                // Client-side validation errors take precedence; repository errors
                // (e.g. pending_mismatch_already_exists) arrive via errorKey.
                val shownError = validationError ?: errorKey
                if (shownError != null) {
                    Spacer(Modifier.height(8.dp))
                    ErrorText(shownError, args = if (validationError == null) errorArgs else emptyList())
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !submitting,
                onClick = {
                    val selected = reason
                    try {
                        if (selected == null) throw LocalizedException("mismatch_reason_required")
                        val qty = if (selected != MismatchRules.NOT_FOUND) qtyText.toIntOrNull() else null
                        val part = if (selected == MismatchRules.WRONG_PART) {
                            wrongPartNo.trim().ifEmpty { null }
                        } else null
                        MismatchRules.validateMismatchInputs(item.qty, selected, qty, part)
                        onConfirm(selected, qty, part, note.trim())
                    } catch (e: LocalizedException) {
                        validationError = e.code
                    }
                },
            ) {
                Text(stringResource(if (submitting) R.string.issue_saving else R.string.issue_confirm))
            }
        },
        dismissButton = {
            TextButton(enabled = !submitting, onClick = onDismiss) {
                Text(stringResource(R.string.issue_cancel))
            }
        },
    )
}

@Composable
private fun reasonLabel(reason: String): String = stringResource(
    when (reason) {
        MismatchRules.NOT_FOUND -> R.string.issue_reason_not_found
        MismatchRules.DAMAGED -> R.string.issue_reason_damaged
        MismatchRules.QTY_MISMATCH -> R.string.issue_reason_qty_mismatch
        MismatchRules.WRONG_PART -> R.string.issue_reason_wrong_part
        MismatchRules.OVER_SHIPMENT -> R.string.issue_reason_over_shipment
        MismatchRules.QUALITY_REJECTION -> R.string.issue_reason_quality_rejection
        else -> R.string.receiving_items_tab_mismatch_reported
    }
)

private fun qtyLabelRes(reason: String): Int = when (reason) {
    MismatchRules.DAMAGED -> R.string.issue_qty_label_damaged
    MismatchRules.QTY_MISMATCH -> R.string.issue_qty_label_qty_mismatch
    MismatchRules.WRONG_PART -> R.string.issue_qty_label_wrong_part
    MismatchRules.OVER_SHIPMENT -> R.string.issue_qty_label_over_shipment
    MismatchRules.QUALITY_REJECTION -> R.string.issue_qty_label_quality_rejection
    else -> R.string.issue_qty_label_qty_mismatch
}

/** Mirrors the web modal: damaged/quality_rejection use the "damaged qty" placeholder. */
private fun qtyPlaceholderRes(reason: String): Int = when (reason) {
    MismatchRules.DAMAGED, MismatchRules.QUALITY_REJECTION -> R.string.issue_qty_placeholder_damaged
    else -> R.string.issue_qty_placeholder_actual_received
}
