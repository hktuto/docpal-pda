package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "transition_logs",
    indices = [
        Index(name = "idx_transition_logs_entity", value = ["entity_type", "entity_id"]),
        Index(name = "idx_transition_logs_created_at", value = ["created_at"]),
    ]
)
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
