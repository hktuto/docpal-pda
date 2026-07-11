package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "transition_logs")
data class TransitionLogEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "entity_type") val entityType: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    @ColumnInfo(name = "from_state") val fromState: String?,
    @ColumnInfo(name = "to_state") val toState: String,
    @ColumnInfo(name = "actor_id") val actorId: String?,
    val metadata: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)
