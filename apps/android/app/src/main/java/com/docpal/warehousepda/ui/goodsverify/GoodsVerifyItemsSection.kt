package com.docpal.warehousepda.ui.goodsverify

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
import com.docpal.warehousepda.domain.model.VerifyBoxItem
import com.docpal.warehousepda.ui.components.DetailRow
import com.docpal.warehousepda.ui.components.EmptyState
import com.docpal.warehousepda.ui.picking.CardDoneColor
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Web verified-pill colors — same green tone as the box list's "Today" pill.
private val VerifiedPillBg = Color(0xFFDCFCE7)
private val VerifiedGreen = Color(0xFF166534)

/**
 * Expected-items section — port of the web box page's item cards, rendered inside
 * the detail screen's LazyColumn. Every Scan button triggers the SAME box-level
 * scan (web parity — there is no per-item pin); the buttons render disabled until
 * Task 8 wires the camera flow ([scanEnabled]).
 */
internal fun LazyListScope.goodsVerifyItemsSection(
    detail: VerifyBoxDetail,
    actionInProgress: Boolean,
    scanEnabled: Boolean = false,
    onScan: () -> Unit = {},
) {
    item(key = "goods-verify-items-title") {
        Text(
            stringResource(R.string.goods_verify_expected_items),
            style = MaterialTheme.typography.titleMedium,
        )
    }
    if (detail.items.isEmpty()) {
        item { EmptyState(stringResource(R.string.goods_verify_no_items)) }
        return
    }
    for (boxItem in detail.items) {
        item(key = "verify-item-${boxItem.partId}") {
            VerifyItemCard(
                item = boxItem,
                actionInProgress = actionInProgress,
                scanEnabled = scanEnabled,
                onScan = onScan,
            )
        }
    }
}

@Composable
private fun VerifyItemCard(
    item: VerifyBoxItem,
    actionInProgress: Boolean,
    scanEnabled: Boolean,
    onScan: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        // Web card--done: green border on verified items.
        border = if (item.verified) BorderStroke(1.dp, CardDoneColor) else null,
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            DetailRow(stringResource(R.string.goods_verify_part), item.partNo)
            DetailRow(stringResource(R.string.goods_verify_qty), item.qty.toString())
            VerifiedRow(item)
            if (!item.verified) {
                Spacer(Modifier.height(8.dp))
                // Box-level scan (no per-item pin) — Task 8 enables these buttons.
                OutlinedButton(onClick = onScan, enabled = scanEnabled && !actionInProgress) {
                    Text(stringResource(R.string.goods_verify_scan))
                }
            }
        }
    }
}

/** Web: pending badge + yes/no. Android: timestamp pill when verified, common_no otherwise. */
@Composable
private fun VerifiedRow(item: VerifyBoxItem) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(
            stringResource(R.string.goods_verify_verified_label),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (item.verified && item.verifiedAt != null) {
            // Finished-style pill — StatusBadge shape, the web's verified tone.
            Text(
                formatDateTime(item.verifiedAt),
                style = MaterialTheme.typography.labelSmall,
                color = VerifiedGreen,
                modifier = Modifier
                    .clip(RoundedCornerShape(9999.dp))
                    .background(VerifiedPillBg)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        } else {
            Text(
                stringResource(if (item.verified) R.string.common_yes else R.string.common_no),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/** epoch ms → yyyy-MM-dd HH:mm in the device timezone (minSdk 24, no java.time desugaring). */
private fun formatDateTime(epochMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
    fmt.timeZone = TimeZone.getDefault()
    return fmt.format(Date(epochMs))
}
