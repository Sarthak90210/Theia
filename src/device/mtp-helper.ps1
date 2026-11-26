# Theia's bridge to Android phones (and other MTP/PTP cameras) on Windows.
#
# One long-lived process per connection. Requests arrive on stdin, one JSON
# object per line. Each reply is one JSON header line on stdout, followed by
# exactly `bytes` raw bytes when the reply carries file data. A scan can also
# send progress lines with the same id before its final reply. Requests run one
# at a time, in order.
#
# Reads go through the Windows IStream underneath MediaDevices' wrapper: the
# wrapper refuses to seek and turns a failed read into a silent end of file,
# which would truncate a copy without anyone noticing.
#
# Nothing here writes to or deletes from the phone.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dll = Join-Path $PSScriptRoot 'MediaDevices.dll'
Add-Type -Path $dll
Add-Type -ReferencedAssemblies @($dll, 'System.Web.Extensions') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Web.Script.Serialization;
using MediaDevices;

public sealed class TheiaMtpError : Exception {
  public readonly string Code;
  public TheiaMtpError(string code, string message) : base(message) { Code = code; }
}

public static class TheiaMtp {
  const int Version = 1;
  static Stream output;
  static JavaScriptSerializer json;
  static MediaDevice device;
  // Paths are "/Storage/DCIM/Camera/IMG_1.jpg". "" is the device root.
  static readonly Dictionary<string, MediaFileSystemInfo> nodes = new Dictionary<string, MediaFileSystemInfo>(StringComparer.Ordinal);
  static readonly Dictionary<string, Dictionary<string, MediaFileSystemInfo>> children = new Dictionary<string, Dictionary<string, MediaFileSystemInfo>>(StringComparer.Ordinal);
  static readonly Dictionary<int, OpenFile> files = new Dictionary<int, OpenFile>();
  static int nextHandle = 1;
  static object scanId;
  static int scannedEntries;
  static readonly FieldInfo innerStream = typeof(MediaDevice).Assembly.GetType("MediaDevices.Internal.StreamWrapper")
    .GetField("stream", BindingFlags.Instance | BindingFlags.NonPublic);

  sealed class OpenFile {
    public string Path;
    public MediaFileInfo File;
    public Stream Wrapper;
    public IStream Native;
    public long Position;
  }

  public static void Run() {
    output = Console.OpenStandardOutput();
    json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Length == 0) continue;
      object id = null;
      try {
        var req = json.Deserialize<Dictionary<string, object>>(line);
        id = req.ContainsKey("id") ? req["id"] : null;
        string op = Str(req, "op");
        if (op == "exit") { Reply(id, true, null, null, null, null); break; }
        if (op == "scan") { scanId = id; scannedEntries = 0; }
        byte[] data = null;
        object result = Dispatch(op, req, ref data);
        Reply(id, true, result, null, null, data);
      } catch (Exception e) {
        Exception ex = e;
        while (ex is TargetInvocationException && ex.InnerException != null) ex = ex.InnerException;
        string code = CodeOf(ex);
        Reply(id, false, null, code == "not-found" && !(ex is TheiaMtpError) ? "object not found: " + ex.Message : ex.Message, code, null);
      } finally {
        scanId = null;
      }
    }
    Shutdown();
  }

  static object Dispatch(string op, Dictionary<string, object> req, ref byte[] data) {
    switch (op) {
      case "ping": return new Dictionary<string, object> { { "version", Version } };
      case "devices": return Devices();
      case "open": return Open(Str(req, "deviceId"));
    }
    if (device == null) throw new TheiaMtpError("closed", "No phone is open on this connection.");
    switch (op) {
      case "free": return Free();
      case "list": return List(Str(req, "path"));
      case "stat": return Stat(Str(req, "path"));
      case "scan": return Scan(req);
      case "open-file": return OpenRead(Str(req, "path"));
      case "read": data = Read(Int(req, "handle"), Int(req, "length")); return null;
      case "seek": Seek(Int(req, "handle"), Long(req, "offset")); return null;
      case "close-file": CloseFile(Int(req, "handle")); return null;
      case "thumb": data = Thumbnail(Str(req, "path")); return null;
      case "forget": Forget(); return null;
    }
    throw new TheiaMtpError("bad-request", "Unknown phone operation: " + op);
  }

  /* ------------------------------------------------------------- devices */

  static object Devices() {
    var list = new List<object>();
    foreach (var d in MediaDevice.GetDevices()) {
      try {
        list.Add(new Dictionary<string, object> {
          { "deviceId", d.DeviceId ?? "" }, { "name", d.FriendlyName ?? "" },
          { "description", d.Description ?? "" }, { "manufacturer", d.Manufacturer ?? "" },
        });
      } catch { /* a device that vanished while listing */ }
      finally { try { d.Dispose(); } catch { } }
    }
    return list;
  }

  static object Open(string deviceId) {
    // Opening again (a retry after the phone was unlocked) starts clean, so
    // storage that has appeared since is seen.
    Forget();
    if (device != null) { try { device.Disconnect(); } catch { } try { device.Dispose(); } catch { } device = null; }
    MediaDevice found = null;
    foreach (var d in MediaDevice.GetDevices()) {
      if (found == null && string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase)) found = d;
      else { try { d.Dispose(); } catch { } }
    }
    if (found == null) throw new TheiaMtpError("detached", "The phone is no longer connected.");
    found.Connect(MediaDeviceAccess.Default, MediaDeviceShare.Default, false);
    device = found;
    var storages = new List<object>();
    foreach (var kv in Children("")) if (kv.Value is MediaDirectoryInfo) storages.Add(kv.Key);
    string serial = "", model = "", firmware = "", manufacturer = "", name = "";
    try { serial = device.SerialNumber ?? ""; } catch { }
    try { model = device.Model ?? ""; } catch { }
    try { firmware = device.FirmwareVersion ?? ""; } catch { }
    try { manufacturer = device.Manufacturer ?? ""; } catch { }
    try { name = device.FriendlyName ?? ""; } catch { }
    if (name.Length == 0) { try { name = device.Description ?? ""; } catch { } }
    return new Dictionary<string, object> {
      { "name", name }, { "model", model }, { "manufacturer", manufacturer }, { "serial", serial },
      { "firmware", firmware }, { "storages", storages },
    };
  }

  static object Free() {
    long free = 0;
    try { foreach (var drive in device.GetDrives()) { try { free += drive.AvailableFreeSpace; } catch { } } } catch { }
    return free;
  }

  /* ---------------------------------------------------------- browsing */

  static string Normalize(string path) {
    if (path == null) return "";
    path = path.Replace('\\', '/');
    while (path.EndsWith("/")) path = path.Substring(0, path.Length - 1);
    if (path.Length > 0 && !path.StartsWith("/")) path = "/" + path;
    return path;
  }

  static MediaFileSystemInfo Resolve(string path) {
    path = Normalize(path);
    MediaFileSystemInfo node;
    if (nodes.TryGetValue(path, out node)) return node;
    if (path.Length == 0) { node = device.GetRootDirectory(); nodes[""] = node; return node; }
    int cut = path.LastIndexOf('/');
    var siblings = Children(path.Substring(0, cut));
    if (!siblings.TryGetValue(path.Substring(cut + 1), out node)) throw new TheiaMtpError("not-found", "object not found: " + path);
    return node;
  }

  /** A folder's entries, listed once and remembered: listing a big folder over MTP takes seconds. */
  static Dictionary<string, MediaFileSystemInfo> Children(string dir) {
    dir = Normalize(dir);
    Dictionary<string, MediaFileSystemInfo> kids;
    if (children.TryGetValue(dir, out kids)) return kids;
    var folder = Resolve(dir) as MediaDirectoryInfo;
    if (folder == null) throw new TheiaMtpError("not-found", "object not found: " + dir + " is not a folder");
    kids = new Dictionary<string, MediaFileSystemInfo>(StringComparer.Ordinal);
    foreach (var entry in folder.EnumerateFileSystemInfos()) {
      if (scanId != null && ++scannedEntries % 250 == 0) {
        var progress = new Dictionary<string, object> { { "id", scanId }, { "progress", scannedEntries }, { "bytes", 0 } };
        var line = Encoding.UTF8.GetBytes(json.Serialize(progress) + "\n");
        output.Write(line, 0, line.Length);
        output.Flush();
      }
      if (string.IsNullOrEmpty(entry.Name) || entry.Name.IndexOf('/') >= 0) continue;
      kids[entry.Name] = entry;
      nodes[dir + "/" + entry.Name] = entry;
    }
    children[dir] = kids;
    return kids;
  }

  static void Forget() {
    foreach (var f in files.Values) { try { f.Wrapper.Dispose(); } catch { } }
    files.Clear();
    nodes.Clear();
    children.Clear();
  }

  static object List(string path) {
    // A listing asked for by name is always fresh.
    string dir = Normalize(path);
    var stale = new List<string>();
    foreach (var key in children.Keys) if (key == dir || key.StartsWith(dir + "/")) stale.Add(key);
    foreach (var key in stale) children.Remove(key);
    var names = new List<object>();
    foreach (var name in Children(dir).Keys) names.Add(name);
    return names;
  }

  static long Ms(DateTime? value) {
    if (!value.HasValue) return 0;
    DateTime t = value.Value;
    if (t.Year < 1980 || t.Year > 2200) return 0;
    if (t.Kind != DateTimeKind.Utc) t = t.ToUniversalTime();
    return (long)(t - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
  }

  static Dictionary<string, object> Describe(MediaFileSystemInfo node) {
    long mtime = Ms(node.LastWriteTime);
    long ctime = Ms(node.DateAuthored);
    if (ctime == 0) ctime = Ms(node.CreationTime);
    return new Dictionary<string, object> {
      { "size", node is MediaDirectoryInfo ? 0L : (long)node.Length }, { "mtimeMs", mtime != 0 ? mtime : ctime },
      { "ctimeMs", ctime }, { "isDirectory", node is MediaDirectoryInfo },
    };
  }

  static object Stat(string path) {
    var node = Resolve(path);
    node.Refresh();
    return Describe(node);
  }

  /**
   * Every media file under the named folders of every storage, in one request:
   * a round trip per file would take minutes for a big camera roll. Folders
   * that start with a dot or hold a .nomedia file are what Android's own
   * gallery leaves out (trash, thumbnails, app caches), so they are left out here.
   */
  static object Scan(Dictionary<string, object> req) {
    Forget();
    var roots = Strings(req, "roots");
    var skip = new HashSet<string>(Strings(req, "skip"), StringComparer.OrdinalIgnoreCase);
    var extensions = new HashSet<string>(Strings(req, "extensions"), StringComparer.OrdinalIgnoreCase);
    var found = new List<object>();
    var storages = new List<object>();
    int folders = 0;
    foreach (var storage in Children("")) {
      if (!(storage.Value is MediaDirectoryInfo)) continue;
      storages.Add(storage.Key);
      foreach (var root in roots) {
        string dir = "/" + storage.Key;
        bool present = true;
        foreach (var part in root.Split('/')) {
          if (part.Length == 0) continue;
          MediaFileSystemInfo next;
          if (!Children(dir).TryGetValue(part, out next) || !(next is MediaDirectoryInfo)) { present = false; break; }
          dir = dir + "/" + part;
        }
        if (present) { folders++; Walk(dir, 0, skip, extensions, found); }
      }
    }
    return new Dictionary<string, object> { { "storages", storages }, { "folders", folders }, { "files", found } };
  }

  static void Walk(string dir, int depth, HashSet<string> skip, HashSet<string> extensions, List<object> found) {
    if (depth > 12) return;
    var kids = Children(dir);
    if (kids.ContainsKey(".nomedia")) return;
    foreach (var kv in kids) {
      if (kv.Key.StartsWith(".") || kv.Value is MediaDirectoryInfo) continue;
      if (!extensions.Contains(Path.GetExtension(kv.Key))) continue;
      var item = Describe(kv.Value);
      if ((long)item["size"] <= 0) continue;
      item["path"] = dir + "/" + kv.Key;
      found.Add(item);
    }
    foreach (var kv in kids) {
      if (!(kv.Value is MediaDirectoryInfo) || kv.Key.StartsWith(".") || skip.Contains(kv.Key)) continue;
      Walk(dir + "/" + kv.Key, depth + 1, skip, extensions, found);
    }
  }

  /* ------------------------------------------------------------- reading */

  static IStream NativeOf(Stream wrapper) {
    var native = innerStream == null ? null : innerStream.GetValue(wrapper) as IStream;
    if (native == null) throw new TheiaMtpError("unsupported", "The pinned Windows device library has changed; Theia can't read from phones with it.");
    return native;
  }

  static object OpenRead(string path) {
    var file = Resolve(path) as MediaFileInfo;
    if (file == null) throw new TheiaMtpError("not-found", "object not found: " + path + " is a folder");
    var wrapper = file.OpenRead();
    var open = new OpenFile { Path = Normalize(path), File = file, Wrapper = wrapper, Native = NativeOf(wrapper), Position = 0 };
    int handle = nextHandle++;
    files[handle] = open;
    return new Dictionary<string, object> { { "handle", handle }, { "size", (long)file.Length } };
  }

  static OpenFile FileOf(int handle) {
    OpenFile f;
    if (!files.TryGetValue(handle, out f)) throw new TheiaMtpError("bad-request", "That file is not open.");
    return f;
  }

  static int ReadInto(IStream native, byte[] buffer, int offset, int count) {
    IntPtr got = Marshal.AllocHGlobal(4);
    try {
      byte[] chunk = offset == 0 ? buffer : new byte[count];
      Marshal.WriteInt32(got, 0);
      native.Read(chunk, count, got);
      int n = Marshal.ReadInt32(got);
      if (offset != 0 && n > 0) Buffer.BlockCopy(chunk, 0, buffer, offset, n);
      return n;
    } finally { Marshal.FreeHGlobal(got); }
  }

  static byte[] Read(int handle, int length) {
    var f = FileOf(handle);
    if (length <= 0) return new byte[0];
    length = Math.Min(length, 16 * 1024 * 1024);
    var buffer = new byte[length];
    int total = 0;
    while (total < length) {
      int n = ReadInto(f.Native, buffer, total, length - total);
      if (n <= 0) break;
      total += n;
    }
    f.Position += total;
    if (total == length) return buffer;
    var exact = new byte[total];
    Buffer.BlockCopy(buffer, 0, exact, 0, total);
    return exact;
  }

  static void Skip(OpenFile f, long count) {
    var scratch = new byte[1024 * 1024];
    while (count > 0) {
      int n = ReadInto(f.Native, scratch, 0, (int)Math.Min(scratch.Length, count));
      if (n <= 0) throw new TheiaMtpError("short", "The phone ended the file early.");
      count -= n;
      f.Position += n;
    }
  }

  static void Seek(int handle, long offset) {
    var f = FileOf(handle);
    if (offset < 0) throw new TheiaMtpError("bad-request", "A negative offset.");
    if (offset == f.Position) return;
    try {
      f.Native.Seek(offset, 0, IntPtr.Zero);
      f.Position = offset;
      return;
    } catch (NotImplementedException) {
    } catch (COMException) {
      // Most MTP drivers can't seek. Read forward instead, or start again.
    }
    if (offset < f.Position) {
      try { f.Wrapper.Dispose(); } catch { }
      f.Wrapper = f.File.OpenRead();
      f.Native = NativeOf(f.Wrapper);
      f.Position = 0;
    }
    Skip(f, offset - f.Position);
  }

  static void CloseFile(int handle) {
    OpenFile f;
    if (!files.TryGetValue(handle, out f)) return;
    files.Remove(handle);
    try { f.Wrapper.Dispose(); } catch { }
  }

  /** The phone's own small preview, or nothing when it has none. */
  static byte[] Thumbnail(string path) {
    var file = Resolve(path) as MediaFileInfo;
    if (file == null) return new byte[0];
    Stream wrapper;
    try { wrapper = file.OpenThumbnail(); } catch (COMException) { return new byte[0]; } catch (NotImplementedException) { return new byte[0]; }
    if (wrapper == null) return new byte[0];
    try {
      var native = NativeOf(wrapper);
      var result = new MemoryStream();
      var buffer = new byte[256 * 1024];
      while (result.Length < 8 * 1024 * 1024) {
        int n = ReadInto(native, buffer, 0, buffer.Length);
        if (n <= 0) break;
        result.Write(buffer, 0, n);
      }
      return result.ToArray();
    } catch (COMException) {
      return new byte[0];
    } finally { try { wrapper.Dispose(); } catch { } }
  }

  /* ------------------------------------------------------------ plumbing */

  static string CodeOf(Exception e) {
    var mine = e as TheiaMtpError;
    if (mine != null) return mine.Code;
    if (e is FileNotFoundException || e is DirectoryNotFoundException) return "not-found";
    uint hr = (uint)e.HResult;
    switch (hr) {
      case 0x80070002: case 0x80070003: case 0x80070490: return "not-found";
      // Not connected, gone, not ready, general failure, I/O device error, timeout, no such device.
      case 0x8007048F: case 0x80070037: case 0x80070015: case 0x8007001F: case 0x8007045D: case 0x80070079: case 0x800701B1:
      case 0x80070006: case 0x800704C7: case 0x80042009: return "detached";
    }
    return "error";
  }

  static void Reply(object id, bool ok, object result, string error, string code, byte[] data) {
    var header = new Dictionary<string, object> { { "id", id }, { "ok", ok }, { "bytes", data == null ? 0 : data.Length } };
    if (ok) header["result"] = result;
    else { header["error"] = error ?? "The phone did not answer."; header["code"] = code ?? "error"; }
    var bytes = new UTF8Encoding(false).GetBytes(json.Serialize(header) + "\n");
    output.Write(bytes, 0, bytes.Length);
    if (data != null && data.Length > 0) output.Write(data, 0, data.Length);
    output.Flush();
  }

  static void Shutdown() {
    Forget();
    if (device != null) { try { device.Disconnect(); } catch { } try { device.Dispose(); } catch { } }
  }

  static string Str(Dictionary<string, object> req, string key) {
    object value;
    if (!req.TryGetValue(key, out value) || !(value is string)) throw new TheiaMtpError("bad-request", "Missing " + key + ".");
    return (string)value;
  }
  static int Int(Dictionary<string, object> req, string key) { return checked((int)Long(req, key)); }
  static long Long(Dictionary<string, object> req, string key) {
    object value;
    if (!req.TryGetValue(key, out value) || value == null) throw new TheiaMtpError("bad-request", "Missing " + key + ".");
    return Convert.ToInt64(value);
  }
  static List<string> Strings(Dictionary<string, object> req, string key) {
    var list = new List<string>();
    object value;
    if (req.TryGetValue(key, out value) && value is System.Collections.IEnumerable && !(value is string)) {
      foreach (var item in (System.Collections.IEnumerable)value) if (item is string) list.Add((string)item);
    }
    return list;
  }
}
'@
[TheiaMtp]::Run()
