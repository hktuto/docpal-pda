package com.docpal.warehousepda

/**
 * Runs [block] on a background thread and rethrows any exception.
 *
 * AppDatabase.build intentionally disallows main-thread queries (production
 * behavior), so test queries that touch Room synchronously run off the main
 * thread. Fails loudly if the block does not finish within 10 seconds.
 */
internal fun <T> offMainThread(block: () -> T): T {
    var result: Result<T>? = null
    val t = Thread { result = runCatching(block) }
    t.start()
    t.join(10_000)
    check(!t.isAlive) { "background query timed out" }
    return result!!.getOrThrow()
}
