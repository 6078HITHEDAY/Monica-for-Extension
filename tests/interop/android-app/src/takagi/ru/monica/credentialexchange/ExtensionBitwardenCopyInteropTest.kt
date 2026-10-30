package takagi.ru.monica.credentialexchange

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.bitwarden.api.SyncResponse
import takagi.ru.monica.bitwarden.crypto.BitwardenCrypto
import takagi.ru.monica.bitwarden.service.BitwardenSyncService
import takagi.ru.monica.bitwarden.service.CipherSyncProcessor
import takagi.ru.monica.bitwarden.service.CipherSyncResult
import takagi.ru.monica.bitwarden.service.UploadResult
import takagi.ru.monica.data.PasskeyEntry
import takagi.ru.monica.passkey.PasskeyAuthActivity
import takagi.ru.monica.passkey.PasskeyCredentialIdCodec
import takagi.ru.monica.passkey.PasskeyPrivateKeyStore
import takagi.ru.monica.passkey.PasskeyPrivateKeySupport

/** Actual installed application/Room/key store/upload processor, synthetic HTTP only. */
@RunWith(AndroidJUnit4::class)
class ExtensionBitwardenCopyInteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-315").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true }
    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun proof(entry: PasskeyEntry): JSONObject {
        lateinit var activity: PasskeyAuthActivity
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            activity = PasskeyAuthActivity()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply { isAccessible = true }.invoke(activity, context)
        }
        val auth = PasskeyAuthActivity::class.java.getDeclaredMethod("createAuthenticatorData", String::class.java, Int::class.javaPrimitiveType, PasskeyEntry::class.java)
            .apply { isAccessible = true }.invoke(activity, entry.rpId, 0, entry) as ByteArray
        val client = JSONObject().put("type", "webauthn.get").put("challenge", UUID.randomUUID().toString())
            .put("origin", "https://${entry.rpId}").put("crossOrigin", false).toString().toByteArray()
        val signature = PasskeyAuthActivity::class.java.getDeclaredMethod("signWithPrivateKey", String::class.java, Int::class.javaPrimitiveType, ByteArray::class.java)
            .apply { isAccessible = true }.invoke(activity, entry.privateKeyAlias, entry.publicKeyAlgorithm, auth + sha(client)) as ByteArray
        return JSONObject().put("cipherId", entry.bitwardenCipherId).put("recordId", entry.id)
            .put("credentialId", PasskeyCredentialIdCodec.toWebAuthnId(entry.credentialId)).put("storedCredentialId", entry.credentialId)
            .put("rpId", entry.rpId).put("userHandle", entry.userId).put("notes", entry.notes).put("storedSignCount", entry.signCount)
            .put("protectedRoomReference", PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
            .put("keyMaterialSha256", b64(sha(checkNotNull(PasskeyPrivateKeySupport.decodeFlexiblePrivateKey(
                PasskeyPrivateKeyStore.resolve(context, entry.privateKeyAlias))).pkcs8Bytes)))
            .put("authenticatorData", b64(auth)).put("clientDataJSON", b64(client)).put("signature", b64(signature))
    }

    @Test fun importEditUploadAndReimportCopies(): Unit = runBlocking {
        val input = JSONObject(File(output, "bitwarden-snapshot-input.json").readText())
        require(input.getBoolean("synthetic"))
        val cases = input.getJSONArray("cases")
        require(cases.length() == 3)
        val results = JSONArray()
        val document = JSONObject().put("synthetic", true).put("cases", results)
            .put("scope", "current Android CipherSyncProcessor/Room/protected key/repository edit/upload/fresh vault; synthetic MockWebServer")
            .put("systemCredentialManagerTested", false).put("androidCounterPolicyVerified", false)
        val destination = File(output, "android-bitwarden-copies.json")
        for (index in 0 until cases.length()) {
            val source = cases.getJSONObject(index)
            require(source.getBoolean("synthetic"))
            val name = source.getString("name")
            require(name in setOf("direct", "copies-complete", "copies-cancel"))
            val result = JSONObject().put("name", name).put("status", "failed")
            results.put(result)
            val fixture = TransferFixture()
            val key = BitwardenCrypto.SymmetricCryptoKey(Base64.getDecoder().decode(source.getString("vaultKeyEnc")),
                Base64.getDecoder().decode(source.getString("vaultKeyMac")))
            val ids = mutableSetOf<Long>()
            try {
                val remote = JSONObject(source.getJSONObject("sync").toString())
                val rows = remote.getJSONArray("ciphers")
                val events = JSONArray()
                var revision = 0
                fixture.server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse = synchronized(rows) {
                        val path = request.requestUrl!!.encodedPath
                        if (request.method == "GET" && path == "/sync") return MockResponse().setBody(remote.toString())
                        val id = path.removePrefix("/ciphers/").removeSuffix("/details")
                        val at = (0 until rows.length()).firstOrNull { rows.getJSONObject(it).getString("id") == id }
                        if (path.startsWith("/ciphers/") && at != null) {
                            if (request.method == "GET") { events.put("get:$id"); return MockResponse().setBody(rows.getJSONObject(at).toString()) }
                            if (request.method == "PUT" && !path.endsWith("/details")) {
                                val update = JSONObject(request.body.readUtf8())
                                if (update.optString("lastKnownRevisionDate") != rows.getJSONObject(at).getString("revisionDate")) {
                                    events.put("conflict:$id")
                                    return MockResponse().setResponseCode(409).setBody("{\"message\":\"Revision conflict\"}")
                                }
                                update.remove("lastKnownRevisionDate")
                                val updated = update.put("id", id)
                                    .put("creationDate", rows.getJSONObject(at).getString("creationDate"))
                                    .put("revisionDate", "2026-10-10T12:00:${(++revision).toString().padStart(2, '0')}.000Z")
                                rows.put(at, updated); events.put("update:$id")
                                return MockResponse().setBody(updated.toString())
                            }
                        }
                        events.put("unexpected:${request.method}:$path")
                        MockResponse().setResponseCode(404)
                    }
                }
                suspend fun newVault(): takagi.ru.monica.data.bitwarden.BitwardenVault {
                    val target = fixture.bitwarden(unlocked = false); ids += target.databaseId
                    val vault = requireNotNull(fixture.db.bitwardenVaultDao().getVaultById(target.databaseId)).copy(
                        encryptedEncKey = b64(source.getString("vaultKeyEnc").toByteArray()),
                        encryptedMacKey = b64(source.getString("vaultKeyMac").toByteArray()))
                    fixture.db.bitwardenVaultDao().update(vault)
                    return vault
                }
                val expected = source.getJSONArray("expected")
                suspend fun importRows(vault: takagi.ru.monica.data.bitwarden.BitwardenVault): List<PasskeyEntry> {
                    val decoded = json.decodeFromString<SyncResponse>(remote.toString())
                    for (cipher in decoded.ciphers) {
                        val synced = CipherSyncProcessor(context).syncCipherFromServer(vault, cipher, key)
                        assertFalse(synced.toString(), synced is CipherSyncResult.Error)
                    }
                    return fixture.db.passkeyDao().getAllPasskeysSync().filter { it.bitwardenVaultId == vault.id }
                }
                fun validate(entries: List<PasskeyEntry>): JSONArray {
                    assertEquals(expected.length(), entries.size)
                    return JSONArray(entries.map { entry ->
                        val id = PasskeyCredentialIdCodec.toWebAuthnId(entry.credentialId)
                        val wanted = (0 until expected.length()).map { expected.getJSONObject(it) }
                            .single { it.getString("credentialId") == id && it.getString("cipherId") == entry.bitwardenCipherId }
                        assertEquals(wanted.getString("rpId"), entry.rpId)
                        assertEquals(wanted.getString("userHandle"), entry.userId)
                        assertEquals(wanted.getLong("signCount"), entry.signCount)
                        assertEquals(-7, entry.publicKeyAlgorithm)
                        assertTrue(PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
                        proof(entry).also { assertEquals(wanted.getString("keyMaterialSha256"), it.getString("keyMaterialSha256")) }
                    })
                }
                val vault = newVault()
                val before = importRows(vault)
                result.put("before", validate(before))
                assertEquals(before.map { it.id }.sorted(), importRows(vault).map { it.id }.sorted())
                for (entry in before) fixture.passkeys.updatePasskey(entry.copy(notes = "Android $name ${entry.bitwardenCipherId}\n---\n完整备注🔑"))
                val upload = BitwardenSyncService(context).uploadModifiedEntries(vault, fixture.accessToken, key)
                result.put("upload", upload.toString()).put("events", events)
                assertTrue(upload.toString(), upload is UploadResult.Success)
                upload as UploadResult.Success
                assertEquals(0, upload.failed)
                assertEquals(expected.length(), upload.uploaded)
                result.put("ciphers", JSONArray(rows.toString()))
                val fresh = importRows(newVault())
                result.put("fresh", validate(fresh))
                for (entry in fresh) {
                    assertFalse(before.any { it.id == entry.id })
                    assertEquals("Android $name ${entry.bitwardenCipherId}\n---\n完整备注🔑", entry.notes)
                }
                result.put("status", "passed")
            } catch (error: Throwable) {
                result.put("error", error.toString())
            } finally {
                try { fixture.db.passkeyDao().getAllPasskeysSync().filter { it.bitwardenVaultId in ids }
                    .forEach { fixture.passkeys.deletePasskeyByRecordId(it.id) } }
                finally { fixture.close(); key.clear(); destination.writeText(document.toString(2)) }
            }
        }
        val passed = (0 until results.length()).all { results.getJSONObject(it).getString("status") == "passed" }
        document.put("status", if (passed) "passed" else "failed")
        destination.writeText(document.toString(2))
        assertTrue("Current Android Bitwarden fixture has a recorded failure", passed)
    }
}
