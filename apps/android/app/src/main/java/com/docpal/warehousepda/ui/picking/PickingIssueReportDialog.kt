package com.docpal.warehousepda.ui.picking

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.PickingOrderSummary
import com.docpal.warehousepda.ui.components.ErrorText

/** Issue reasons in the web's picker order (pickingIssueReasons). */
private val REASONS = listOf("insufficient_stock", "cannot_divide", "merge", "other")

/**
 * Batch picking-issue report dialog — port of the web PickingIssueReportModal.
 * Validates client-side with the same rules as the web modal (validation strings
 * are `picking_issue_validation_*` resources, rendered inline in red) and surfaces
 * repository errors via [errorKey] while open ([errorArgs] are its `%1$s` format
 * args). [submitting] disables inputs.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickingIssueReportDialog(
    orders: List<PickingOrderSummary>,
    submitting: Boolean,
    errorKey: String?,
    errorArgs: List<String> = emptyList(),
    onDismiss: () -> Unit,
    onConfirm: (
        reason: String,
        qty: Int?,
        packSize: Int?,
        note: String?,
        remarks: Map<String, String>,
    ) -> Unit,
) {
    // Form state resets when the selected order set changes (web resets on modal open).
    val orderKey = orders.map { it.id }
    var reason by remember(orderKey) { mutableStateOf(REASONS.first()) }
    var qtyText by remember(orderKey) { mutableStateOf("") }
    var packSizeText by remember(orderKey) { mutableStateOf("") }
    var note by remember(orderKey) { mutableStateOf("") }
    var remarks by remember(orderKey) { mutableStateOf(orders.associate { it.id to "" }) }
    var validationErrorRes by remember(orderKey) { mutableStateOf<Int?>(null) }
    var reasonExpanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        title = { Text(stringResource(R.string.picking_issue_modal_title)) },
        text = {
            Column {
                ExposedDropdownMenuBox(
                    expanded = reasonExpanded,
                    onExpandedChange = { if (!submitting) reasonExpanded = it },
                ) {
                    OutlinedTextField(
                        value = stringResource(reasonLabelRes(reason)),
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(stringResource(R.string.picking_issue_modal_issue_reason)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = reasonExpanded) },
                        modifier = Modifier
                            .menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled = !submitting)
                            .fillMaxWidth(),
                    )
                    ExposedDropdownMenu(
                        expanded = reasonExpanded,
                        onDismissRequest = { reasonExpanded = false },
                    ) {
                        REASONS.forEach { r ->
                            DropdownMenuItem(
                                text = { Text(stringResource(reasonLabelRes(r))) },
                                onClick = {
                                    reason = r
                                    // Fields from a previous reason don't carry over.
                                    qtyText = ""
                                    packSizeText = ""
                                    validationErrorRes = null
                                    reasonExpanded = false
                                },
                            )
                        }
                    }
                }

                if (reason == "insufficient_stock") {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = qtyText,
                        onValueChange = { qtyText = it.filter { c -> c.isDigit() }; validationErrorRes = null },
                        label = { Text(stringResource(R.string.picking_issue_modal_actual_qty_available)) },
                        placeholder = { Text(stringResource(R.string.picking_issue_modal_actual_qty_placeholder)) },
                        singleLine = true,
                        enabled = !submitting,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                if (reason == "cannot_divide") {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = packSizeText,
                        onValueChange = { packSizeText = it.filter { c -> c.isDigit() }; validationErrorRes = null },
                        label = { Text(stringResource(R.string.picking_issue_modal_pack_size)) },
                        placeholder = { Text(stringResource(R.string.picking_issue_modal_pack_size_placeholder)) },
                        singleLine = true,
                        enabled = !submitting,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(R.string.picking_issue_modal_per_order_remarks),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                orders.forEach { order ->
                    Spacer(Modifier.height(8.dp))
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(order.refNo, style = MaterialTheme.typography.titleSmall)
                        if (reason == "cannot_divide") {
                            Text(
                                stringResource(R.string.picking_issue_modal_requested, order.totalQty),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                    OutlinedTextField(
                        value = remarks[order.id] ?: "",
                        onValueChange = { value ->
                            remarks = remarks + (order.id to value)
                            validationErrorRes = null
                        },
                        placeholder = { Text(stringResource(R.string.picking_issue_modal_remark_placeholder)) },
                        singleLine = true,
                        enabled = !submitting,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it; validationErrorRes = null },
                    label = { Text(stringResource(R.string.picking_issue_modal_common_note)) },
                    placeholder = { Text(stringResource(R.string.picking_issue_modal_common_note_placeholder)) },
                    minLines = 2,
                    enabled = !submitting,
                    modifier = Modifier.fillMaxWidth(),
                )

                // Client-side validation errors take precedence; repository errors
                // (e.g. no_reportable_orders_selected) arrive via errorKey.
                val shownValidation = validationErrorRes
                if (shownValidation != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        stringResource(shownValidation),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                } else if (errorKey != null) {
                    Spacer(Modifier.height(8.dp))
                    ErrorText(errorKey, args = errorArgs)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !submitting,
                onClick = {
                    val qty = qtyText.toIntOrNull()
                    val packSize = packSizeText.toIntOrNull()
                    val errorRes = when {
                        reason == "merge" && orders.size < 2 ->
                            R.string.picking_issue_validation_merge_min_orders
                        reason == "insufficient_stock" && (qty == null || qty < 0) ->
                            R.string.picking_issue_validation_valid_available_qty
                        reason == "cannot_divide" && (packSize == null || packSize <= 0) ->
                            R.string.picking_issue_validation_valid_pack_size
                        reason == "other" && note.trim().isEmpty() &&
                            remarks.values.none { it.trim().isNotEmpty() } ->
                            R.string.picking_issue_validation_note_or_remark
                        else -> null
                    }
                    if (errorRes != null) {
                        validationErrorRes = errorRes
                        return@TextButton
                    }
                    onConfirm(
                        reason,
                        if (reason == "insufficient_stock") qty else null,
                        if (reason == "cannot_divide") packSize else null,
                        note.trim().ifEmpty { null },
                        remarks.mapValues { it.value.trim() }.filterValues { it.isNotEmpty() },
                    )
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

private fun reasonLabelRes(reason: String): Int = when (reason) {
    "insufficient_stock" -> R.string.picking_issue_reason_insufficient_stock
    "cannot_divide" -> R.string.picking_issue_reason_cannot_divide
    "merge" -> R.string.picking_issue_reason_merge
    else -> R.string.picking_issue_reason_other
}
