param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$req = Get-Content -Raw -Encoding UTF8 -LiteralPath $RequestPath | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'MediaDevices.dll')

# DownloadFile writes a WPD resource into this hashing stream. No original is
# transcoded by Theia or written into an unencrypted temporary file.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Security.Cryptography;
public sealed class TheiaHashSink : Stream {
  private readonly SHA256 hash = SHA256.Create();
  private long count;
  public long Count { get { return count; } }
  public override bool CanRead { get { return false; } }
  public override bool CanSeek { get { return false; } }
  public override bool CanWrite { get { return true; } }
  public override long Length { get { return count; } }
  public override long Position { get { return count; } set { throw new NotSupportedException(); } }
  public override void Flush() {}
  public override int Read(byte[] b, int o, int n) { throw new NotSupportedException(); }
  public override long Seek(long n, SeekOrigin o) { throw new NotSupportedException(); }
  public override void SetLength(long n) { throw new NotSupportedException(); }
  public override void Write(byte[] b, int o, int n) { hash.TransformBlock(b, o, n, null, 0); count = checked(count + n); }
  public string Finish() { hash.TransformFinalBlock(new byte[0], 0, 0); return BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant(); }
  protected override void Dispose(bool disposing) { if (disposing) hash.Dispose(); base.Dispose(disposing); }
  public static string HashRead(Stream input) {
    input.Position = 0;
    using (SHA256 h = SHA256.Create()) { return BitConverter.ToString(h.ComputeHash(input)).Replace("-", "").ToLowerInvariant(); }
  }
}
'@

function Check-Cancel {
  if ($req.cancelPath -and (Test-Path -LiteralPath $req.cancelPath)) { throw 'Stopped before the next iPhone operation.' }
}
function Normalize-Id([string]$value) {
  if (-not $value) { return '' }
  $clean = $value.Trim().ToLowerInvariant().Replace('-', '')
  if ($clean -notmatch '^(?:[a-f0-9]{24}|[a-f0-9]{40})$') { return '' }
  return $clean
}
function Has-InstanceId([string]$value, [string]$wanted) {
  foreach ($part in ($value -split '[\\#]')) { if ((Normalize-Id $part) -ceq $wanted) { return $true } }
  return $false
}
function File-Object($file) {
  if (($file.Attributes -band [MediaDevices.MediaFileAttributes]::Directory) -or
      ($file.Attributes -band [MediaDevices.MediaFileAttributes]::Object)) { throw 'The Windows object is not a regular photo file.' }
  if (-not $file.Id -or -not $file.PersistentUniqueId -or $file.Length -le 0 -or $file.Length -gt 9007199254740991) {
    throw 'Windows did not provide a persistent file identity and exact size.'
  }
  return @{ objectId = [string]$file.Id; persistentId = [string]$file.PersistentUniqueId; name = [string]$file.Name;
    bytes = [int64]$file.Length; path = [string]$file.FullName;
    canDelete = [bool]($file.Attributes -band [MediaDevices.MediaFileAttributes]::CanDelete) }
}
function Current-Object($expected) {
  Check-Cancel
  $file = $device.GetFileInfo([string]$expected.path)
  $file.Refresh()
  $current = File-Object $file
  if ($current.objectId -cne [string]$expected.objectId -or $current.persistentId -cne [string]$expected.persistentId -or
      $current.path -cne [string]$expected.path -or $current.name -cne [string]$expected.name -or $current.bytes -ne [int64]$expected.bytes) {
    throw "The Windows photo identity changed: $($expected.name)"
  }
  return $current
}
function Hash-Object($expected) {
  $current = Current-Object $expected
  $sink = New-Object TheiaHashSink
  try {
    $device.DownloadFileFromPersistentUniqueId([string]$current.persistentId, $sink)
    $digest = $sink.Finish()
    $bytes = $sink.Count
  } finally { $sink.Dispose() }
  Check-Cancel
  $again = Current-Object $expected
  if ($bytes -ne $again.bytes) { throw "Windows returned different-length photo bytes: $($expected.name)" }
  return @{ object = $again; bytes = [int64]$bytes; sha256 = $digest }
}
function Check-BackupPath([string]$file) {
  if (-not [IO.Path]::IsPathRooted($file)) { throw 'The backup path is not absolute.' }
  $full = [IO.Path]::GetFullPath($file)
  $entry = New-Object IO.FileInfo($full)
  while ($null -ne $entry) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The backup path contains a symbolic link or junction.' }
    if ($entry -is [IO.FileInfo]) { $entry = $entry.Directory } else { $entry = $entry.Parent }
  }
  return $full
}
function Delete-PinnedObject($expected) {
  # MediaDevice.DeleteFile resolves a path again. Use this pinned SDK's existing
  # Item instead, so its Delete(false) targets the verified WPD object ID.
  $info = $device.GetFileInfo([string]$expected.path)
  $info.Refresh()
  $current = File-Object $info
  if ($current.objectId -cne [string]$expected.objectId -or $current.persistentId -cne [string]$expected.persistentId -or
      $current.bytes -ne [int64]$expected.bytes -or -not $current.canDelete) { throw 'The photo identity changed at deletion.' }
  $field = [MediaDevices.MediaFileInfo].GetField('item', [Reflection.BindingFlags]'Instance,NonPublic')
  if (-not $field) { throw 'The pinned Windows SDK object interface is unavailable.' }
  $item = $field.GetValue($info)
  $idProperty = $item.GetType().GetProperty('Id', [Reflection.BindingFlags]'Instance,Public')
  if (-not $idProperty -or [string]$idProperty.GetValue($item, $null) -cne [string]$expected.objectId) { throw 'The Windows SDK object ID is inconsistent.' }
  $method = $item.GetType().GetMethod('Delete', [Reflection.BindingFlags]'Instance,Public', $null, [Type[]]@([bool]), $null)
  if (-not $method) { throw 'The pinned nonrecursive deletion method is unavailable.' }
  [void]$method.Invoke($item, [object[]]@($false))
}

$device = $null
$devices = @()
$locks = New-Object 'Collections.Generic.List[IDisposable]'
try {
  if ($req.op -eq 'self-test') {
    $sink = New-Object TheiaHashSink
    try { $bytes = [Text.Encoding]::UTF8.GetBytes('abc'); $sink.Write($bytes, 0, $bytes.Length); $digest = $sink.Finish() }
    finally { $sink.Dispose() }
    $itemType = [MediaDevices.MediaDevice].Assembly.GetType('MediaDevices.Internal.Item')
    $deleteMethod = $itemType.GetMethod('Delete', [Reflection.BindingFlags]'Instance,Public', $null, [Type[]]@([bool]), $null)
    if (-not $deleteMethod -or -not [MediaDevices.MediaFileInfo].GetField('item', [Reflection.BindingFlags]'Instance,NonPublic')) { throw 'The pinned Windows SDK object interface is unavailable.' }
    @{ ok = $true; version = [MediaDevices.MediaDevice].Assembly.GetName().Version.ToString(); sha256 = $digest; deleteByObjectId = $true } | ConvertTo-Json -Compress
    exit 0
  }
  if (@('inventory','hash','delete') -notcontains $req.op) { throw 'Unknown Windows photo operation.' }
  $identity = Normalize-Id ([string]$req.udid)
  if (-not $identity) { throw 'The AFC iPhone identifier is not a valid UDID.' }
  Check-Cancel
  $devices = @([MediaDevices.MediaDevice]::GetDevices())
  $matches = New-Object 'Collections.Generic.List[object]'
  foreach ($candidate in $devices) {
    Check-Cancel
    # Names never establish identity. They only avoid opening non-Apple devices.
    if (-not (Has-InstanceId ([string]$candidate.DeviceId) $identity) -and [string]$candidate.Manufacturer -notmatch '^Apple(?:\b|$)') { continue }
    try {
      $candidate.Connect([MediaDevices.MediaDeviceAccess]::Default, [MediaDevices.MediaDeviceShare]::Default, $false)
      $serial = ''; $pnp = ''
      try { $serial = [string]$candidate.SerialNumber } catch {}
      try { $pnp = [string]$candidate.PnPDeviceID } catch {}
      if ((Normalize-Id $serial) -ceq $identity -or (Has-InstanceId $pnp $identity) -or (Has-InstanceId ([string]$candidate.DeviceId) $identity)) {
        $matches.Add(@{ device = $candidate; serial = $identity })
      } else { $candidate.Disconnect() }
    } catch { try { $candidate.Disconnect() } catch {} }
  }
  if ($matches.Count -ne 1) { throw "Windows could not identify exactly the selected iPhone by its UDID. No phone files were deleted." }
  $device = $matches[0].device
  $serial = $matches[0].serial
  $deleteSupported = @($device.SupportedCommands()) -contains [MediaDevices.Commands]::ObjectManagementDeleteObjects

  if ($req.op -eq 'inventory') {
    $names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @($req.names)) { [void]$names.Add([string]$name) }
    if (-not $names.Count) { throw 'Specific photo filenames are required.' }
    $objects = New-Object 'Collections.Generic.List[object]'
    foreach ($filePath in $device.EnumerateFiles('\', '*', [IO.SearchOption]::AllDirectories)) {
      Check-Cancel
      if (-not $names.Contains([IO.Path]::GetFileName([string]$filePath))) { continue }
      $objects.Add((File-Object ($device.GetFileInfo($filePath))))
    }
    @{ deviceId = [string]$device.DeviceId; serial = $serial; deleteSupported = [bool]$deleteSupported; objects = @($objects.ToArray()) } | ConvertTo-Json -Compress -Depth 8
    exit 0
  }
  if ($req.op -eq 'hash') { Hash-Object $req.object | ConvertTo-Json -Compress -Depth 8; exit 0 }
  if (-not $deleteSupported) { throw 'The iPhone driver does not advertise photo deletion support.' }

  $prepared = New-Object 'Collections.Generic.List[object]'
  $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($file in @($req.files)) {
    Check-Cancel
    if (-not $seen.Add([string]$file.object.objectId) -or [string]$file.sha256 -notmatch '^[a-f0-9]{64}$' -or
        [int64]$file.bytes -le 0 -or [int64]$file.bytes -ne [int64]$file.object.bytes) { throw 'The verified file request is incomplete or ambiguous.' }
    $current = Current-Object $file.object
    if (-not $current.canDelete) { throw "The iPhone does not allow deletion of $($current.name)." }
    $backupPath = Check-BackupPath ([string]$file.destination)
    # FileShare.Read rejects concurrent writers, replacement, rename and removal.
    $backup = New-Object IO.FileStream($backupPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $locks.Add($backup)
    if ($backup.Length -ne [int64]$file.bytes -or [TheiaHashSink]::HashRead($backup) -cne [string]$file.sha256) { throw "The backup changed before deletion: $($current.name)" }
    $resource = Hash-Object $current
    if ($resource.sha256 -cne [string]$file.sha256 -or $resource.bytes -ne [int64]$file.bytes) {
      throw "Windows is exposing different or transcoded bytes for $($current.name). The original stays on the iPhone."
    }
    $prepared.Add(@{ request = $file; backup = $backup })
  }
  if (-not $prepared.Count) { throw 'There are no fully verified files.' }

  # All members have passed and their backups remain locked. There are no retries.
  $requested = New-Object 'Collections.Generic.List[object]'
  $failed = New-Object 'Collections.Generic.List[object]'
  foreach ($entry in $prepared) {
    $file = $entry.request
    try {
      Check-Cancel
      $resource = Hash-Object $file.object
      if (-not $resource.object.canDelete -or $resource.sha256 -cne [string]$file.sha256 -or
          [TheiaHashSink]::HashRead($entry.backup) -cne [string]$file.sha256) { throw 'The source or backup changed at the final check.' }
      Check-Cancel
      Delete-PinnedObject $file.object
      $requested.Add($file.object)
    } catch {
      $failed.Add(@{ objectId = [string]$file.object.objectId; reason = $_.Exception.Message })
      # A disconnected/rejected request stops this item; never continue blindly.
      break
    }
  }

  # Confirm absence using persistent IDs from a fresh enumeration. A stale path,
  # a moved item or an unavailable driver is never reported as a successful delete.
  $remainingIds = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $remainingPersistent = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $postCheck = $null
  try {
    foreach ($filePath in $device.EnumerateFiles('\', '*', [IO.SearchOption]::AllDirectories)) {
      Check-Cancel
      $info = $device.GetFileInfo($filePath)
      [void]$remainingIds.Add([string]$info.Id)
      [void]$remainingPersistent.Add([string]$info.PersistentUniqueId)
    }
    if ((Normalize-Id ([string]$device.SerialNumber)) -cne $identity -and
        -not (Has-InstanceId ([string]$device.PnPDeviceID) $identity) -and -not (Has-InstanceId ([string]$device.DeviceId) $identity)) { throw 'The device identity changed after deletion.' }
  } catch { $postCheck = $_.Exception.Message }
  $deleted = New-Object 'Collections.Generic.List[string]'
  foreach ($object in $requested) {
    if (-not $postCheck -and -not $remainingIds.Contains([string]$object.objectId) -and -not $remainingPersistent.Contains([string]$object.persistentId)) {
      $deleted.Add([string]$object.objectId)
    } else { $failed.Add(@{ objectId = [string]$object.objectId; reason = $(if ($postCheck) { 'Deletion outcome is unconfirmed: ' + $postCheck } else { 'The object remains on the iPhone.' }) }) }
  }
  @{ deleted = @($deleted.ToArray()); failed = @($failed.ToArray()) } | ConvertTo-Json -Compress -Depth 8
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  foreach ($handle in $locks) { $handle.Dispose() }
  foreach ($item in $devices) { try { $item.Disconnect() } catch {}; try { $item.Dispose() } catch {} }
}
