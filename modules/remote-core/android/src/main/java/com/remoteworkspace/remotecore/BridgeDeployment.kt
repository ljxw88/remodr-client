package com.remoteworkspace.remotecore

import net.schmizz.sshj.sftp.FileAttributes
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.RenameFlags
import net.schmizz.sshj.sftp.Response.StatusCode
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.sftp.SFTPException
import java.security.MessageDigest
import java.util.EnumSet
import java.util.UUID

internal interface BridgeDeploymentStore {
  fun matches(path: String, bytes: ByteArray): Boolean
  fun mkdirs(path: String)
  fun writeExclusive(path: String, bytes: ByteArray)
  fun publishAtomically(staging: String, destination: String): Boolean
  fun remove(path: String)
}

internal fun bridgeVersionPath(directory: String, bytes: ByteArray): String {
  val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  return "$directory/herdr_mobile_bridge-$hash.pyz"
}

internal fun deployBridge(
  directory: String,
  bytes: ByteArray,
  store: BridgeDeploymentStore,
): String {
  val destination = bridgeVersionPath(directory, bytes)
  if (store.matches(destination, bytes)) return destination
  store.mkdirs(directory)
  val staging = "${destination.removeSuffix(".pyz")}-${UUID.randomUUID()}.upload.pyz"
  var retained = false
  try {
    store.writeExclusive(staging, bytes)
    if (!store.matches(staging, bytes)) throw HerdrBridgeException("Bridge upload failed integrity verification")
    if (!store.publishAtomically(staging, destination)) {
      // Without atomic rename, launch only our fully verified unique file.
      // Other deployers cannot truncate it, including clients on another device.
      retained = true
      return staging
    }
    if (!store.matches(destination, bytes)) throw HerdrBridgeException("Published bridge failed integrity verification")
    return destination
  } finally {
    if (!retained) runCatching { store.remove(staging) }
  }
}

internal class SftpBridgeDeploymentStore(private val sftp: SFTPClient) : BridgeDeploymentStore {
  override fun matches(path: String, bytes: ByteArray): Boolean {
    val attributes = try {
      sftp.lstat(path)
    } catch (error: SFTPException) {
      if (error.statusCode == StatusCode.NO_SUCH_FILE) return false
      throw error
    }
    if (attributes.type != FileMode.Type.REGULAR || attributes.size != bytes.size.toLong()) return false
    sftp.open(path, EnumSet.of(OpenMode.READ)).use { file ->
      val actual = ByteArray(bytes.size)
      var offset = 0
      while (offset < actual.size) {
        val read = file.read(offset.toLong(), actual, offset, minOf(32768, actual.size - offset))
        if (read <= 0) return false
        offset += read
      }
      return actual.contentEquals(bytes)
    }
  }

  override fun mkdirs(path: String) {
    try {
      sftp.mkdirs(path)
    } catch (error: SFTPException) {
      // Another deployer may have created the directory after mkdirs' stat.
      if (sftp.statExistence(path)?.type != FileMode.Type.DIRECTORY) throw error
    }
  }

  override fun writeExclusive(path: String, bytes: ByteArray) {
    sftp.open(
      path,
      EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.EXCL),
      FileAttributes.Builder().withPermissions(448).build(),
    ).use { file ->
      var offset = 0
      while (offset < bytes.size) {
        val length = minOf(32768, bytes.size - offset)
        file.write(offset.toLong(), bytes, offset, length)
        offset += length
      }
    }
  }

  override fun publishAtomically(staging: String, destination: String): Boolean {
    if (sftp.version() < 5 && !sftp.getSFTPEngine().supportsServerExtension("posix-rename", "openssh.com")) {
      return false
    }
    return try {
      sftp.rename(staging, destination, EnumSet.of(RenameFlags.ATOMIC, RenameFlags.OVERWRITE))
      true
    } catch (error: SFTPException) {
      if (error.statusCode == StatusCode.OP_UNSUPPORTED) false else throw error
    }
  }

  override fun remove(path: String) {
    sftp.rm(path)
  }
}
