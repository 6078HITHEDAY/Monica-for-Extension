package takagi.ru.monica.lansync

import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import takagi.ru.monica.data.PasswordDatabase
import takagi.ru.monica.data.PasswordEntry
import takagi.ru.monica.data.CustomField
import takagi.ru.monica.data.SecureItem
import takagi.ru.monica.data.ItemType
import takagi.ru.monica.passkey.PasskeyPrivateKeyStore
import takagi.ru.monica.security.SecurityManager
import takagi.ru.monica.security.SessionManager
import takagi.ru.monica.steam.data.SteamDatabase
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID

/** Explicit opt-in, synthetic stores only. The control socket is emulator-loopback
 * and forwarded by adb; production JNI, provider and encrypted storage do the work. */
class Extension321NearbyInteropTest {
    @Test fun browserRoundTrip() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("browserInterop") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "browser-interop-${UUID.randomUUID()}")
        val db = Room.inMemoryDatabaseBuilder(context, PasswordDatabase::class.java).build()
        val steam = Room.inMemoryDatabaseBuilder(context, SteamDatabase::class.java).build()
        val security = SecurityManager(context)
        val preferenceName = "browser-interop-${UUID.randomUUID()}"
        val preferences = DeviceSyncPreferenceStore(context, security, preferenceName)
        // AVD networking does not expose its listener or multicast to the host.
        // Use the smallest valid ID so the browser listens and Android dials;
        // both production stacks still authenticate the paired identity.
        val settings = DeviceSyncPreferences(deviceId = "0", intervalSeconds = 300)
        preferences.save(settings)
        var provider = DevicePasswordSyncProvider(context, security, preferences, db, File(root,"replica"), steam)
        var handle: Long? = null; var enrollment = false; var acknowledged = false
        var incoming = File(root,"initial")
        var running = true; var rounds = 0
        SessionManager.markUnlocked()
        try {
            db.passwordEntryDao().insertPasswordEntry(PasswordEntry(title="Android synthetic",website="",username="android",password=security.encryptData("android-original")))

            val first = db.passwordEntryDao().getDeviceSyncLocalPasswords().single()
            db.customFieldDao().insert(CustomField(entryId=first.id, title="monica.autofill.url_rules", value="""{"version":1,"future":9007199254740993,"urls":[{"url":"www.android.example.test","mode":"HOST"}]}"""))
            db.customFieldDao().insert(CustomField(entryId=first.id, title="monica.content.credential", value="""{"version":1,"groupId":"00000000-0000-0000-0000-000000000091","passwordId":"00000000-0000-0000-0000-000000000092","label":"Android account","primary":true,"groupOrder":0,"passwordOrder":0,"note":"Android note","future":9007199254740993}"""))
            for (template in listOf("MEMBERSHIP","REWARDS","TRAVEL")) {
                val data = JSONObject().put("documentType","OTHER").put("documentNumber","0000123007").put("fullName","Synthetic holder")
                    .put("walletTemplate",template).put("walletFields",JSONObject().put("points","0001250.50").put("departure","2026-10-21T10:30+08:00").put("future","  Raw value  "))
                db.secureItemDao().insertItem(SecureItem(itemType=ItemType.DOCUMENT,title="Android "+template,itemData=security.encryptDataLegacyCompat(data.toString())))
            }
            ServerSocket(39484, 2, InetAddress.getByName("127.0.0.1")).use { server ->
                server.soTimeout = 600_000
                while (running) server.accept().use { socket ->
                    socket.soTimeout = 180_000
                    val text = socket.getInputStream().bufferedReader().readLine()
                    require(text.length < 4096)
                    val command = JSONObject(text)
                    val result = try {
                        when(command.getString("op")) {
                            "status" -> JSONObject().put("ready",true).put("rounds",rounds)
                            "seedStress" -> {
                                check(handle == null)
                                val count = command.getInt("count"); require(count in 1..1000)
                                for(index in 0 until count) db.passwordEntryDao().insertPasswordEntry(PasswordEntry(
                                    title="Android stress $index", website="https://stress.example.test/$index", username="用户-$index-🔐",
                                    password=security.encryptData("安卓密码-$index-\n\"\\-🔑"), notes="  note-$index\n第二行\t  "))
                                JSONObject().put("seeded",count)
                            }
                            "inspectStress" -> {
                                val passwords = JSONArray(db.passwordEntryDao().getDeviceSyncLocalPasswords().map {
                                    JSONObject().put("id",it.id).put("title",it.title).put("password",security.decryptData(it.password))
                                        .put("username",it.username).put("notes",it.notes).put("deleted",it.isDeleted)
                                })
                                val secure = JSONArray(db.secureItemDao().getDeviceSyncLocalItems().map {
                                    JSONObject().put("id",it.id).put("title",it.title).put("deleted",it.isDeleted)
                                        .put("data",security.decryptDataIfMonicaCiphertext(it.itemData))
                                })
                                JSONObject().put("passwords",passwords).put("secure",secure).put("rounds",rounds)
                            }
                            "mutateStress" -> {
                                check(handle == null)
                                val title = command.getString("title"); val action = command.getString("action")
                                val entry = db.passwordEntryDao().getDeviceSyncLocalPasswords().single { it.title == title }
                                when(action) {
                                    "edit" -> db.passwordEntryDao().updatePasswordEntry(entry.copy(
                                        password=security.encryptData(command.getString("password")), notes=command.optString("notes",entry.notes), updatedAt=java.util.Date()))
                                    "trash" -> db.passwordEntryDao().updatePasswordEntry(entry.copy(isDeleted=true,deletedAt=java.util.Date(),updatedAt=java.util.Date()))
                                    "restore" -> db.passwordEntryDao().updatePasswordEntry(entry.copy(isDeleted=false,deletedAt=null,updatedAt=java.util.Date()))
                                    "purge" -> db.passwordEntryDao().deletePasswordEntry(entry)
                                    else -> error("Unknown mutation")
                                }
                                JSONObject().put("changed",true)
                            }
                            "cancel" -> {
                                handle?.let { RustLanSync.request(JSONObject().put("operation","cancel").put("handle",it))
                                    // Cancellation is asynchronous. Match the application coordinator:
                                    // release only after the native worker has finished cleaning up.
                                    withTimeout(15_000) {
                                        while (RustLanSync.request(JSONObject().put("operation","progress").put("handle",it))
                                                .getString("phase") !in listOf("completed","failed","cancelled")) delay(25)
                                    }
                                    RustLanSync.request(JSONObject().put("operation","release").put("handle",it)) }
                                handle=null; JSONObject().put("cancelled",true)
                            }
                            "reopen" -> {
                                check(handle == null); provider.pause()
                                provider = DevicePasswordSyncProvider(context, security, preferences, db, File(root,"replica"), steam)
                                JSONObject().put("reopened",true)
                            }
                            "pair", "sync" -> {
                                check(handle == null)
                                enrollment = command.getString("op") == "pair"; acknowledged = false
                                val directory = File(root,"out-${UUID.randomUUID()}")
                                val outgoing = if(enrollment) DevicePairingSnapshot.prepare(directory,settings.deviceId) else provider.prepare(directory)
                                incoming = File(root,"in-${UUID.randomUUID()}")
                                val peer = settings.peers.singleOrNull()
                                val device = JSONObject().put("device_id",settings.deviceId).put("name","Synthetic Android")
                                    .put("pair_id",if(enrollment) "" else peer!!.pairId).put("interval_seconds",settings.intervalSeconds)
                                    .put("settings_version",settings.settingsVersion).put("settings_writer",settings.settingsWriter)
                                    .put("sync_request",settings.syncRequest).put("revision",outgoing.revision)
                                    .put("content_type","vault").put("vault_content_version",2).put("sync_mode","bidirectional")
                                val request = JSONObject().put("operation","connect").put("protocol",2).put("vault_id","monica-passwords-v1")
                                    .put("device",device).put("content_key",outgoing.contentKey).put("outgoing_directory",outgoing.directory.absolutePath)
                                    .put("incoming_directory",incoming.absolutePath).put("invitation",if(enrollment) command.getString("invitation")
                                        else "monica-lan:2:10.0.2.2:${command.getInt("port")}:${peer!!.trustedKey}")
                                if(!enrollment) request.put("expected_device_id",peer!!.deviceId)
                                val started = RustLanSync.request(request); handle = started.getLong("handle"); JSONObject().put("started",true)
                            }
                            "progress" -> {
                                val id = requireNotNull(handle)
                                val state = RustLanSync.request(JSONObject().put("operation","progress").put("handle",id))
                                val phase = state.getString("phase")
                                check(phase != "failed") { state.optString("error") }
                                if(phase == "received" && !acknowledged) {
                                    val remote = state.getJSONObject("peer")
                                    if(enrollment) {
                                        val pair = remote.getJSONObject("pairing")
                                        settings.peers += SavedSyncPeer(remote.getString("device_id"),remote.getString("name"),pair.getString("pair_id"),pair.getString("trusted_key"))
                                        preferences.save(settings)
                                        assertEquals(1,db.passwordEntryDao().getDeviceSyncLocalPasswords().size)
                                    } else if(remote.optBoolean("receive_content",true)) {
                                        provider.apply(incoming,remote)
                                        val items = db.passwordEntryDao().getDeviceSyncLocalPasswords()
                                        assertTrue(items.all { it.password != "browser-original" && it.password != "android-original" })
                                        for(key in db.passkeyDao().getAllPasskeysSync()) {
                                            val bytes = Base64.getDecoder().decode(requireNotNull(PasskeyPrivateKeyStore.resolve(context,key.privateKeyAlias)))
                                            val privateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(bytes)); bytes.fill(0)
                                            val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(key.publicKey)))
                                            val challenge = "android-interop-signature".toByteArray()
                                            val signed = Signature.getInstance("SHA256withECDSA").run { initSign(privateKey); update(challenge); sign() }
                                            assertTrue(Signature.getInstance("SHA256withECDSA").run { initVerify(publicKey); update(challenge); verify(signed) })
                                            assertEquals(0L,key.signCount)
                                        }
                                    }
                                    RustLanSync.request(JSONObject().put("operation","acknowledge").put("handle",id).put("success",true)); acknowledged = true
                                }
                                if(phase == "completed") {
                                    RustLanSync.request(JSONObject().put("operation","release").put("handle",id)); handle=null
                                    if(!enrollment) rounds++
                                }
                                JSONObject().put("phase",phase)
                            }
                            "inspect" -> JSONObject().put("items",JSONArray(db.passwordEntryDao().getDeviceSyncLocalPasswords().map {
                                JSONObject().put("title",it.title).put("password",security.decryptData(it.password))
                            })).put("passkeys",db.passkeyDao().getAllPasskeysSync().size)
                            "edit" -> {
                                val entry = db.passwordEntryDao().getDeviceSyncLocalPasswords().single { it.title == "Browser synthetic" }
                                db.passwordEntryDao().updatePasswordEntry(entry.copy(password=security.encryptData("android-edited"),updatedAt=java.util.Date()))
                                JSONObject().put("edited",true)
                            }
                            "inspect321" -> {
                                val passwords = JSONArray()
                                for(entry in db.passwordEntryDao().getDeviceSyncLocalPasswords()) {
                                    val custom = JSONArray()
                                    for(field in db.customFieldDao().getFieldsByEntryIdSync(entry.id)) custom.put(JSONObject().put("name",field.title)
                                        .put("value",security.decryptDataIfMonicaCiphertext(field.value)).put("protected",field.isProtected))
                                    passwords.put(JSONObject().put("title",entry.title).put("fields",custom))
                                }
                                val wallets = JSONArray()
                                for(item in db.secureItemDao().getDeviceSyncLocalItems()) wallets.put(JSONObject().put("title",item.title)
                                    .put("data",JSONObject(security.decryptDataIfMonicaCiphertext(item.itemData))))
                                JSONObject().put("passwords",passwords).put("wallets",wallets)
                            }
                            "edit321" -> {
                                val entry = db.passwordEntryDao().getDeviceSyncLocalPasswords().single { it.title == "Browser synthetic" }
                                for(field in db.customFieldDao().getFieldsByEntryIdSync(entry.id)) {
                                    val raw = security.decryptDataIfMonicaCiphertext(field.value)
                                    val next = when(field.title) {
                                        "monica.content.credential" -> raw.replace("Browser note","Android edited note")
                                        "monica.autofill.url_rules" -> raw.replace("HOST","NEVER")
                                        else -> raw
                                    }
                                    if(next != raw) db.customFieldDao().update(field.copy(value=if(field.isProtected) security.encryptData(next) else next))
                                }
                                db.passwordEntryDao().updatePasswordEntry(entry.copy(updatedAt=java.util.Date()))
                                for(item in db.secureItemDao().getDeviceSyncLocalItems().filter { it.title.startsWith("Browser ") }) {
                                    val data = JSONObject(security.decryptDataIfMonicaCiphertext(item.itemData))
                                    data.getJSONObject("walletFields").put("seat","08A").remove("points")
                                    db.secureItemDao().updateItem(item.copy(itemData=security.encryptDataLegacyCompat(data.toString()),updatedAt=java.util.Date()))
                                }
                                JSONObject().put("edited",true)
                            }
                            "stop" -> { running=false; JSONObject().put("stopped",true) }
                            else -> error("Unknown synthetic control command")
                        }
                    } catch(error: Throwable) { JSONObject().put("error",error.javaClass.simpleName+": "+error.message) }
                    socket.getOutputStream().bufferedWriter().apply { write(result.toString()); newLine(); flush() }
                }
            }
            assertTrue(rounds >= 2)
        } finally {
            handle?.let { runCatching { RustLanSync.request(JSONObject().put("operation","cancel").put("handle",it)) } }
            for(key in db.passkeyDao().getAllPasskeysSync()) PasskeyPrivateKeyStore.removeIfProtectedReference(context,key.privateKeyAlias)
            provider.pause(); db.close(); steam.close(); context.deleteSharedPreferences(preferenceName)
            if(root.canonicalFile.parentFile == context.cacheDir.canonicalFile) root.deleteRecursively()
            SessionManager.markLocked()
        }
    }
}
