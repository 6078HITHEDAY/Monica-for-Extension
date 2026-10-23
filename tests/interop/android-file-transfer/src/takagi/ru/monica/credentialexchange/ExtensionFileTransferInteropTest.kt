package takagi.ru.monica.credentialexchange

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.io.File
import app.keemobile.kotpass.cryptography.EncryptedValue
import app.keemobile.kotpass.database.Credentials
import app.keemobile.kotpass.database.KeePassDatabase
import app.keemobile.kotpass.database.decode
import app.keemobile.kotpass.models.Group
import takagi.ru.monica.data.BackupPreferences
import takagi.ru.monica.util.DataExportImportManager
import takagi.ru.monica.utils.WebDavHelper

/** Synthetic files and independent temporary KDBX destinations; never clears an existing vault. */
class ExtensionFileTransferInteropTest {
    @Test fun importExtensionFilesAndExportWithAndroid(): Unit = runBlocking {
        val f = TransferFixture()
        val root = File(f.context.filesDir, "extension-file-transfer-20261023").apply { mkdirs() }
        val password = "synthetic-file-password"
        val prefs = BackupPreferences(includeImages = false, includePasskeys = false, includeGeneratorHistory = false,
            includeTimeline = false, includeTrash = false, includeTrashAndHistory = false)
        try {
            check(File(root, "extension.zip").isFile) { "Push synthetic extension fixtures first" }
            val source = f.keepass()
            assertEquals(3, f.model.importZipBackup(Uri.fromFile(File(root, "extension.zip")), password, source).getOrThrow())
            val prepared = f.model.prepareZipBackup(preferences = prefs, backupEncryptionPassword = password, source = source).getOrThrow().first
            try { prepared.copyTo(File(root, "android-return.zip"), overwrite = true) } finally { prepared.delete() }
            f.model.exportKdbxBackup(Uri.fromFile(File(root, "android-return.kdbx")), password, source).getOrThrow()
            // Android's real restore decoder verifies the stored data after the targeted import.
            val restored = WebDavHelper(f.context).restoreFromBackupFile(File(root, "android-return.zip"), password,
                restoreMonicaConfig = false, importDataOnly = true).getOrThrow().content
            assertEquals(1, restored.passwords.size)
            val account = restored.passwords.single()
            assertEquals("  用户@example.invalid  ", f.security.decryptDataIfMonicaCiphertext(account.username))
            assertEquals("  pass,\"word\r\n🔑  ", f.security.decryptDataIfMonicaCiphertext(account.password))
            assertEquals(2, restored.secureItems.size)
            val native = f.keepass()
            File(root, "extension.kdbx").copyTo(f.keepassFile(native.databaseId!!), overwrite = true)
            val incoming = File(root, "extension.kdbx").inputStream().use { KeePassDatabase.decode(it, Credentials.from(EncryptedValue.fromString(password))) }
            fun entryCount(group: Group): Int = group.entries.size + group.groups.sumOf(::entryCount)
            assertEquals(3, entryCount(incoming.content.group))
            // File password is from the extension rather than the temporary destination's original password.
            f.db.localKeePassDatabaseDao().getDatabaseById(native.databaseId)?.let { database ->
                f.db.localKeePassDatabaseDao().updateDatabase(database.copy(encryptedPassword = f.security.encryptData(password)))
            }
            f.model.exportKdbxBackup(Uri.fromFile(File(root, "android-kdbx-return.kdbx")), password, native).getOrThrow()
            val manager = DataExportImportManager(f.context)
            assertEquals(1, manager.importData(Uri.fromFile(File(root, "extension.csv"))).getOrThrow().size)
            assertEquals(1, manager.importAegisJson(Uri.fromFile(File(root, "extension-aegis.json"))).getOrThrow().size)
            assertEquals(1, manager.importStratumJson(Uri.fromFile(File(root, "extension-stratum.json"))).getOrThrow().size)
            assertEquals(1, manager.importStratumTxt(Uri.fromFile(File(root, "extension-otp.txt"))).getOrThrow().size)
            val steam = manager.importSteamMaFile(Uri.fromFile(File(root, "extension.maFile"))).getOrThrow()
            assertEquals("synthetic-steam", steam.name)
            File(root, "android-result.json").writeText(JSONObject().put("zipImported", 3).put("zipExported", 3)
                .put("kdbxImported", 3).put("csvImported", 1).put("aegisImported", 1).put("stratumImported", 1)
                .put("otpImported", 1).put("steamImported", 1).put("sensitiveWhitespacePreserved", true).toString(2))
        } finally { f.close() }
    }
}
