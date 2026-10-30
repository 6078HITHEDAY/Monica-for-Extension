package takagi.ru.monica.credentialexchange

import android.graphics.Bitmap
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.viewModelScope
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import takagi.ru.monica.data.*
import takagi.ru.monica.data.model.*
import takagi.ru.monica.repository.*
import takagi.ru.monica.ui.LocalUiSecurityManager
import takagi.ru.monica.ui.screens.AddEditPasswordScreen
import takagi.ru.monica.ui.screens.PasswordDetailScreen
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.viewmodel.MdbxViewModel
import takagi.ru.monica.viewmodel.PasswordViewModel
import uniffi.mdbx_ffi.openVault

/** Current application writer -> actual Edge native edit -> Compose editor -> native readback. */
class ExtensionProjectFieldsUiInteropTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var fixture: TransferFixture
    private lateinit var model: PasswordViewModel
    private lateinit var target: ImportDestination
    private lateinit var database: LocalMdbxDatabase
    private val output get() = File(fixture.context.filesDir, "extension-interop-315").apply { mkdirs() }

    @Before fun setup() = runBlocking {
        fixture = TransferFixture()
        target = fixture.mdbx()
        database = requireNotNull(fixture.db.localMdbxDatabaseDao().getDatabaseById(target.databaseId))
        model = PasswordViewModel(fixture.passwords, fixture.security,
            customFieldRepository = CustomFieldRepository(fixture.db.customFieldDao()), context = fixture.context,
            localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(fixture.context))
    }
    @After fun cleanup() = runBlocking { model.viewModelScope.cancel(); fixture.close() }

    private suspend fun reopen() {
        Mdbx2NativeReadSessions.clear()
        val manager = MdbxViewModel(fixture.context.applicationContext as android.app.Application,
            fixture.db.localMdbxDatabaseDao(), fixture.db.mdbxRemoteSourceDao(), fixture.db.passwordEntryDao(),
            fixture.db.secureItemDao(), fixture.db.passkeyDao(), fixture.db.attachmentDao(), fixture.db.customFieldDao(), fixture.security)
        try {
            manager.syncVault(database.id)
            val result = withTimeout(45_000) { manager.operationState.first {
                it is MdbxViewModel.OperationState.Success || it is MdbxViewModel.OperationState.Error
            } }
            assertTrue(result.toString(), result is MdbxViewModel.OperationState.Success)
        } finally { manager.viewModelScope.cancel() }
    }
    private suspend fun records(): JSONArray = JSONArray(fixture.mdbx.readStoredEntries(database.id)
        .filter { !it.deleted }.sortedBy { it.entryId }.map {
            JSONObject().put("entryId", it.entryId).put("title", it.title).put("payload", JSONObject(it.payloadJson))
        })
    private fun backup(name: String) {
        Mdbx2NativeReadSessions.clear()
        openVault(database.filePath, "Synthetic transfer fixture password", "project-fields-318").use {
            val destination = File(output, name)
            if (destination.exists()) check(destination.renameTo(File(output, "previous-${System.nanoTime()}-$name")))
            it.createBackup(destination.absolutePath)
        }
    }
    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}") {
            JSONObject.quote(it) + ":" + canonical(value.get(it))
        }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        null, JSONObject.NULL -> "null"
        else -> value.toString()
    }

    @Test fun exportRichProject(): Unit = runBlocking {
        val rawGroups = listOf(
            ProjectCredentialGroup.Group(label = "Primary account", username = "android-primary-user", otp = "JBSWY3DPEHPK3PXP",
                passwords = listOf(ProjectCredentialGroup.Password(value = "first-synthetic-password"), ProjectCredentialGroup.Password(value = "second-synthetic-password"))),
            ProjectCredentialGroup.Group(label = "Recovery account", username = "android-recovery-user",
                passwords = listOf(ProjectCredentialGroup.Password(value = "recovery-synthetic-password")))
        )
        val metadata = ProjectCredentialGroup.rows(rawGroups).associate { row -> row.password.id to requireNotNull(
            ProjectCredentialGroup.parse(row.metadata.raw.toString().dropLast(1) + ",\"futureCounter\":9007199254740993}")) }
        val groups = rawGroups.map { group -> group.copy(passwords = group.passwords.map { it.copy(metadata = metadata.getValue(it.id)) }) }
        val done = CompletableDeferred<Long?>()
        model.savePasswordsAcrossTargets(emptyList(), PasswordEntry(title = "Current rich password project",
            website = "https://one.example.invalid/a;b\nhttps://two.example.invalid/?x=a:b", username = "", password = "",
            notes = "  Recovery notes\r\n中文\tretained  ", email = "synthetic@example.invalid", phone = "00001",
            addressLine = "  街道 12\nUnit 007  ", city = "City 字", state = "State", zipCode = "00007", country = "CN",
            creditCardNumber = "00001234", creditCardHolder = "  ALICE  ", creditCardExpiry = "09/30", creditCardCVV = "007",
            appPackageName = "invalid.synthetic.app", appName = "合成应用"), emptyList(), listOf(StorageTarget.Mdbx(database.id)),
            listOf(CustomFieldDraft(title = "Recovery", value = "  original-secret\r\n保留  ", isProtected = true),
                CustomFieldDraft(title = "Duplicate", value = "first", isProtected = false),
                CustomFieldDraft(title = "Duplicate", value = "second", isProtected = true),
                CustomFieldDraft(title = "monica.content.order", value = "NOTES,PAYMENT,FUTURE:318,CONTACT,ADDRESS,CUSTOM_FIELDS", isProtected = true)),
            projectCredentials = groups, onComplete = { done.complete(it) })
        assertNotNull(withTimeout(45_000) { done.await() })
        reopen()
        val rows = records()
        assertEquals(3, rows.length())
        File(output, "android-project-fields.json").writeText(JSONObject().put("synthetic", true).put("status", "passed")
            .put("rows", rows).put("layer", "Current Android writer and native reopen").toString(2))
        backup("android-project-fields.mdbx")
    }

    @Test fun importEditRichProjectInCompose(): Unit = runBlocking {
        val incoming = File(output, "edge-project-fields.mdbx")
        require(incoming.isFile)
        Mdbx2NativeReadSessions.clear()
        openVault(incoming.absolutePath, "Synthetic transfer fixture password", "project-fields-import-318").use {
            check(File(database.filePath).delete()) // This test's newly-created empty synthetic vault only.
            it.createBackup(database.filePath)
        }
        reopen()
        val before = records()
        assertEquals(3, before.length())
        val entries = fixture.db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == database.id }
        assertEquals(1, entries.map { it.passwordGroupId }.distinct().size)
        assertNotNull(entries.first().passwordGroupId)
        assertEquals(2, entries.count { it.username == "edge-primary-user" })
        val entry = entries.first { it.username == "edge-primary-user" }
        var detail by mutableStateOf(true)
        var saved: Long? = null
        lateinit var focusManager: FocusManager
        compose.setContent {
            focusManager = LocalFocusManager.current
            CompositionLocalProvider(LocalUiSecurityManager provides fixture.security) { MaterialTheme {
                if (detail) PasswordDetailScreen(model, passwordId = entry.id, biometricEnabled = false,
                    onNavigateBack = {}, onEditPassword = {})
                else AddEditPasswordScreen(model, passwordId = entry.id, initialStorageExplicit = true,
                    initialMdbxDatabaseId = database.id, mdbxDatabasesFallback = listOf(database),
                    onSaveCompleted = { saved = it }, onNavigateBack = {})
            } }
        }
        compose.onAllNodesWithText(entry.title).onFirst().assertExists()
        compose.onAllNodes(isRoot()).onLast().captureToImage().asAndroidBitmap().let { bitmap ->
            File(output, "android-project-fields-detail.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        compose.runOnIdle { detail = false }
        compose.onNode(hasSetTextAction() and hasText("edge-primary-user")).performTextReplacement("android-return-user")
        compose.runOnIdle { focusManager.clearFocus(force = true) }
        compose.onNodeWithTag("password_editor_save").performClick()
        compose.waitUntil(45_000) { saved != null }
        reopen()
        val after = records()
        val differences = JSONArray()
        val roomIdChanges = JSONArray()
        assertEquals(before.length(), after.length())
        for (index in 0 until before.length()) {
            val old = before.getJSONObject(index)
            val next = (0 until after.length()).map { after.getJSONObject(it) }.single { it.getString("entryId") == old.getString("entryId") }
            val expected = JSONObject(old.toString())
            val payload = expected.getJSONObject("payload")
            val actualPayload = next.getJSONObject("payload")
            if (payload.optString("username") == "edge-primary-user") payload.put("username", "android-return-user")
            // Room identity belongs to the local projection. Record its remap separately;
            // every other native payload property and stable entry identity is compared.
            if (payload.has("room_id") && actualPayload.has("room_id") && payload.get("room_id") != actualPayload.get("room_id")) {
                roomIdChanges.put(JSONObject().put("entryId", old.getString("entryId")).put("before", payload.get("room_id")).put("after", actualPayload.get("room_id")))
                payload.put("room_id", actualPayload.get("room_id"))
            }
            if (canonical(expected) != canonical(next)) differences.put(JSONObject().put("entryId", old.getString("entryId")).put("expected", expected).put("actual", next))
        }
        File(output, "android-project-fields-return.json").writeText(JSONObject().put("synthetic", true)
            .put("status", if (differences.length() == 0) "passed" else "failed").put("before", before).put("after", after)
            .put("roomIdChanges", roomIdChanges).put("differences", differences).toString(2))
        backup("android-project-fields-return.mdbx")
        assertEquals("Unexpected field changes; see android-project-fields-return.json", 0, differences.length())
    }
}
