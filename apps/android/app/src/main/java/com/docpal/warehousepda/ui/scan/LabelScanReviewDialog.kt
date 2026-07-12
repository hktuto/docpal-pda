package com.docpal.warehousepda.ui.scan

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.scan.ScanPrimitives
import com.docpal.warehousepda.ui.components.ErrorText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Label scan review dialog — port of the web LabelScanReviewModal.vue.
 * Review mode (camera) shows the captured image; manual mode does not.
 * Fields are owned by the VM ([ScanReviewUiState.fields]) so edits survive
 * match/apply state updates; multiple matches require an explicit selection
 * before Apply is enabled (a single match option is pre-selected).
 * Match payload is flow-agnostic: options carry precomputed id + label and
 * [onApply] hands back the selected [ScanMatchOption.id].
 */
@Composable
fun LabelScanReviewDialog(
    review: ScanReviewUiState,
    onFieldsChange: (ScanPrimitives.OcrInput) -> Unit,
    onFindMatch: () -> Unit,
    onApply: (String) -> Unit,
    onRetake: () -> Unit,
    onDismiss: () -> Unit,
) {
    val busy = review.matching || review.applying
    var selectedOptionId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(review.matchOptions) {
        selectedOptionId = review.matchOptions.singleOrNull()?.id
    }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        ) {
            Column(
                Modifier.padding(16.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    stringResource(
                        if (review.manual) R.string.scan_review_title_manual
                        else R.string.scan_review_title_review
                    ),
                    style = MaterialTheme.typography.titleMedium,
                )

                if (!review.manual) {
                    // Decode off the UI thread with downsampling — captures can be
                    // full-frame multi-megapixel JPEGs (RectanglePickerActivity logic).
                    val bitmap by produceState<Bitmap?>(null, review.imagePath) {
                        val path = review.imagePath
                        value = if (path == null) null else withContext(Dispatchers.IO) {
                            decodeSampledBitmap(path, DISPLAY_MAX_DIMENSION)
                        }
                    }
                    if (bitmap != null) {
                        Image(
                            bitmap = bitmap!!.asImageBitmap(),
                            contentDescription = stringResource(R.string.scan_review_captured_label_alt),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Text(
                            stringResource(R.string.scan_review_no_image),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Text(
                    stringResource(R.string.scan_review_edit_subtitle),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                val fields = review.fields
                ScanField(
                    label = stringResource(R.string.scan_review_part_no),
                    placeholder = stringResource(R.string.scan_review_placeholder_part_no),
                    value = fields.partNo,
                    candidates = review.options.itemIds,
                    enabled = !busy,
                    onValueChange = { onFieldsChange(fields.copy(partNo = it)) },
                )
                ScanField(
                    label = stringResource(R.string.scan_review_date_code),
                    placeholder = stringResource(R.string.scan_review_placeholder_date_code),
                    value = fields.dateCode,
                    candidates = review.options.dateCodes,
                    enabled = !busy,
                    onValueChange = { onFieldsChange(fields.copy(dateCode = it)) },
                )
                ScanField(
                    label = stringResource(R.string.scan_review_lot_code),
                    placeholder = stringResource(R.string.scan_review_placeholder_lot_code),
                    value = fields.lotCode,
                    candidates = review.options.lotCodes,
                    enabled = !busy,
                    onValueChange = { onFieldsChange(fields.copy(lotCode = it)) },
                )
                ScanField(
                    label = stringResource(R.string.scan_review_coo),
                    placeholder = stringResource(R.string.scan_review_placeholder_coo),
                    value = fields.coo,
                    candidates = review.options.coos,
                    enabled = !busy,
                    onValueChange = { onFieldsChange(fields.copy(coo = it)) },
                )
                ScanField(
                    label = stringResource(R.string.scan_review_cow),
                    placeholder = stringResource(R.string.scan_review_placeholder_cow),
                    value = fields.cow,
                    candidates = review.options.cows,
                    enabled = !busy,
                    onValueChange = { onFieldsChange(fields.copy(cow = it)) },
                )
                ScanField(
                    label = stringResource(R.string.scan_review_qty),
                    placeholder = stringResource(R.string.scan_review_placeholder_qty),
                    value = fields.qty,
                    candidates = review.options.qtys.map { it.toString() },
                    enabled = !busy,
                    numeric = true,
                    onValueChange = { onFieldsChange(fields.copy(qty = it)) },
                )

                MatchSection(review, selectedOptionId, busy) { selectedOptionId = it }

                if (review.applyErrorKey != null) {
                    Text(
                        stringResource(R.string.scan_review_apply_failed),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    ErrorText(review.applyErrorKey)
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!review.manual) {
                        TextButton(onClick = onRetake, enabled = !busy) {
                            Text(stringResource(R.string.scan_review_retake))
                        }
                    }
                    TextButton(onClick = onDismiss, enabled = !busy) {
                        Text(stringResource(R.string.scan_review_cancel))
                    }
                    Button(onClick = onFindMatch, enabled = !busy) {
                        Text(
                            stringResource(
                                if (review.matching) R.string.scan_review_matching
                                else R.string.scan_review_find_match
                            )
                        )
                    }
                }

                val applyTarget = when (review.matchMessageRes) {
                    R.string.scan_review_match_single -> review.matchOptions.singleOrNull()?.id
                    R.string.scan_review_match_multiple -> selectedOptionId
                    else -> null
                }
                if (review.matchMessageRes == R.string.scan_review_match_single ||
                    review.matchMessageRes == R.string.scan_review_match_multiple
                ) {
                    Button(
                        onClick = { applyTarget?.let(onApply) },
                        enabled = applyTarget != null && !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            stringResource(
                                if (review.applying) R.string.scan_review_applying
                                else R.string.scan_review_apply
                            )
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MatchSection(
    review: ScanReviewUiState,
    selectedOptionId: String?,
    busy: Boolean,
    onSelect: (String) -> Unit,
) {
    when (review.matchMessageRes) {
        R.string.scan_review_match_single -> {
            Text(
                stringResource(R.string.scan_review_match_single),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            review.matchOptions.singleOrNull()?.let { option ->
                Text(option.label, style = MaterialTheme.typography.bodySmall)
            }
        }
        R.string.scan_review_match_multiple -> {
            Text(
                stringResource(R.string.scan_review_match_multiple),
                style = MaterialTheme.typography.bodyMedium,
            )
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (option in review.matchOptions) {
                    val selected = option.id == selectedOptionId
                    OutlinedCard(
                        onClick = { if (!busy) onSelect(option.id) },
                        enabled = !busy,
                        border = BorderStroke(
                            if (selected) 2.dp else 1.dp,
                            if (selected) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outlineVariant,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            option.label,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }
            }
        }
        R.string.scan_review_match_none -> Text(
            stringResource(R.string.scan_review_match_none),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
        R.string.scan_review_error -> {
            Text(
                stringResource(R.string.scan_review_error),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
            review.matchErrorKey?.let { ErrorText(it) }
        }
    }
}

private const val DISPLAY_MAX_DIMENSION = 2048

/** Port of RectanglePickerActivity.loadSampledBitmap: bounds pass + power-of-two downsample. */
private fun decodeSampledBitmap(path: String, maxDimension: Int): Bitmap? = try {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, options)
    var sampleSize = 1
    while (maxOf(options.outWidth, options.outHeight) / (sampleSize * 2) > maxDimension) {
        sampleSize *= 2
    }
    options.inSampleSize = sampleSize
    options.inJustDecodeBounds = false
    BitmapFactory.decodeFile(path, options)
} catch (e: Exception) {
    null
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScanField(
    label: String,
    placeholder: String,
    value: String,
    candidates: List<String>,
    enabled: Boolean,
    numeric: Boolean = false,
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = { onValueChange(if (numeric) it.filter { c -> c.isDigit() } else it) },
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        singleLine = true,
        enabled = enabled,
        keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number)
        else KeyboardOptions.Default,
        modifier = Modifier.fillMaxWidth(),
    )
    CandidateChips(candidates, enabled, onValueChange)
}

/** Web CandidateChips: one chip per candidate when the parse offered alternatives (>1). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CandidateChips(candidates: List<String>, enabled: Boolean, onSelect: (String) -> Unit) {
    if (candidates.size <= 1) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (candidate in candidates) {
            SuggestionChip(
                onClick = { onSelect(candidate) },
                enabled = enabled,
                label = { Text(candidate) },
            )
        }
    }
}
