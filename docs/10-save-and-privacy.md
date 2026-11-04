# Saving, verified iPhone cleanup, and vault privacy

Saving reports logical copied bytes, a trailing transfer rate and an ETA for
copying plus destination read-back. Retries replace the attempt's byte count
instead of inflating progress. Unknown sizes and final commit work show an
estimating/finishing state. Deletion verification is a separate phase because
full video decoding and extra phone reads can take substantially longer.

Delete after save is available only for complete iPhone items. It is off by
default, resets after every choice, and requires an explicit warning dialog.
Individual burst-frame saves and vault-to-vault saves cannot delete the phone.

Before deletion, Theia requires a complete successful save mapping. It reads
every saved file again, compares every iPhone original and companion file by
SHA-256 and size, verifies stable modification times, and fully decodes the
saved photos and videos. Unsupported RAW decoding, malformed edit recipes,
missing files, source changes and cancellation block deletion of that item.
It refreshes the phone database after saving and rereads companion listings.

Windows Portable Devices must identify the exact AFC UDID. A Windows object
must have a unique persistent identity, exact name/size and identical content.
Transcoded Windows representations are refused. The helper holds read-only
backup handles that disallow writes, replacement and deletion, rehashes all
members before the first delete, then targets verified object IDs without
recursion. It confirms absence afterward. Partial or uncertain outcomes are
reported explicitly and never retried automatically. A durable JSON-lines
audit in the destination vault records authorization before driver deletion.
Windows deletion is not promised to be recoverable and may sync through iCloud.
No real iPhone photos were deleted during development qualification.

Vault Hidden and Recently Deleted encrypt media with per-file X25519/HKDF
keys and authenticated AES-256-GCM chunks. The vault private key is wrapped
separately by scrypt-derived passcode and recovery secrets. Filenames, dates,
locations, other database metadata and pre-existing external copies are not
encrypted. A separately visible duplicate remains visible. The operation
reports an incomplete-protection error if an owned plaintext path is shared
or if any file cannot be protected.

Encrypted content is read back before plaintext is removed. Database changes
are durably committed first. Startup preserves orphaned blobs and potential
recovery copies; plaintext leftovers are removed only after authenticating
their encrypted replacements. Restoration refuses to overwrite unrelated files.
Private previews are rendered in memory, HTTP media responses are not cached,
and old private streams stop after locking. Windows lock/suspend locks vaults.

Vault options display the location, size and Explorer action. Removing a vault
from the app keeps its files. Deleting requires the exact vault name, a fresh
manifest/database ownership check and canonical path validation. Drive roots,
protected locations, junctions and overlapping vaults are refused. Recycle Bin
capacity is checked; an explicit permanent option is used when recovery cannot
be promised. No user vaults are deleted by automated tests.

Checks include unit tests with generated devices, real native-module smoke
tests, renderer controls with a fake save endpoint, and the full app UI against
a generated vault. Live Windows/iPhone driver deletion remains unqualified.
