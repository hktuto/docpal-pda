package com.docpal.warehousepda.domain.model

data class User(
    val id: String,
    val username: String,
    val displayName: String,
    val role: String,
    val createdAt: Long,
)
