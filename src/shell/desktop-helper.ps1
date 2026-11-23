# Theia's way into the parts of Windows Electron doesn't reach. One operation
# per run; the result is one line of JSON on stdout: {"ok":true,...} or
# {"error":"..."}.
#
#   verbs      <file>                 What File Explorer's right-click menu offers for the file.
#   invoke     <file> <verb>          Run one of those (an app from Open with, say).
#   share      <file>... at <x> <y>   The Windows share sheet, over Theia's window. Stays
#                                     running until something is chosen and has read the
#                                     files, or for ten minutes, or until Theia quits.
#   wallpaper  <file>                 Desktop background.
#   lockscreen <file>                 Lock screen picture.
#   copy       <file>... [image <f>]  The files onto the clipboard, as File Explorer copies
#                                     them, and the picture too, for pasting into a chat.
param([Parameter(Mandatory=$true)][string]$Op, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

$shellCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class TheiaShellMenu {
  [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellFolder {
    void ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr eaten, out IntPtr pidl, IntPtr attrs);
    void EnumObjects(IntPtr hwnd, int flags, out IntPtr ppenum);
    void BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    void BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr p1, IntPtr p2);
    void CreateViewObject(IntPtr hwnd, ref Guid riid, out IntPtr ppv);
    void GetAttributesOf(uint n, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] pidls, ref uint attrs);
    void GetUIObjectOf(IntPtr hwnd, uint n, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] pidls, ref Guid riid, IntPtr reserved, [MarshalAs(UnmanagedType.Interface)] out object ppv);
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Invoke {
    public int cbSize; public uint fMask; public IntPtr hwnd; public IntPtr lpVerb; public IntPtr lpParameters; public IntPtr lpDirectory;
    public int nShow; public uint dwHotKey; public IntPtr hIcon; public IntPtr lpTitle; public IntPtr lpVerbW; public IntPtr lpParametersW;
    public IntPtr lpDirectoryW; public IntPtr lpTitleW; public int ptX, ptY;
  }
  [ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref Invoke info);
    [PreserveSig] int GetCommandString(UIntPtr cmd, uint type, IntPtr reserved, StringBuilder name, uint cch);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bc, out IntPtr pidl, uint sfgao, out uint psfgao);
  [DllImport("shell32.dll")] static extern int SHBindToParent(IntPtr pidl, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv, out IntPtr child);
  [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
  [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr h, int pos);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr h, uint id, StringBuilder s, int max, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr h, int pos);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SystemParametersInfo(uint action, uint param, string value, uint flags);

  const uint FIRST = 1, LAST = 0x7FFF;

  static IContextMenu MenuFor(string file, out IntPtr pidl) {
    uint attrs;
    if (SHParseDisplayName(file, IntPtr.Zero, out pidl, 0, out attrs) != 0) throw new Exception("Windows can't find the file.");
    Guid iidFolder = typeof(IShellFolder).GUID;
    object folder; IntPtr child;
    if (SHBindToParent(pidl, ref iidFolder, out folder, out child) != 0) throw new Exception("Windows can't open the file's folder.");
    Guid iidMenu = typeof(IContextMenu).GUID;
    object menu;
    ((IShellFolder)folder).GetUIObjectOf(IntPtr.Zero, 1, new[] { child }, ref iidMenu, IntPtr.Zero, out menu);
    return (IContextMenu)menu;
  }

  static void Walk(IContextMenu menu, IntPtr hmenu, string prefix, List<string[]> list) {
    int n = GetMenuItemCount(hmenu);
    for (int i = 0; i < n; i++) {
      var label = new StringBuilder(256);
      GetMenuString(hmenu, (uint)i, label, 256, 0x400);
      string text = label.ToString().Replace("&", "");
      IntPtr sub = GetSubMenu(hmenu, i);
      if (sub != IntPtr.Zero) { Walk(menu, sub, prefix + text + " > ", list); continue; }
      uint id = GetMenuItemID(hmenu, i);
      if (id == 0xFFFFFFFF || id < FIRST || id > LAST || text.Length == 0) continue;
      var verb = new StringBuilder(256);
      string v = "";
      try { if (menu.GetCommandString((UIntPtr)(id - FIRST), 4, IntPtr.Zero, verb, 256) == 0) v = verb.ToString(); } catch { }
      list.Add(new[] { v, prefix + text, id.ToString() });
    }
  }

  /** [canonical verb or "", label, command id] for every command, as Explorer lists them. */
  public static List<string[]> List(string file) {
    IntPtr pidl;
    var menu = MenuFor(file, out pidl);
    IntPtr hmenu = CreatePopupMenu();
    try {
      menu.QueryContextMenu(hmenu, 0, FIRST, LAST, 0);
      var list = new List<string[]>();
      Walk(menu, hmenu, "", list);
      return list;
    } finally { DestroyMenu(hmenu); Marshal.FreeCoTaskMem(pidl); }
  }

  /** Run the command with this canonical verb, or this label for commands without one. */
  public static void Run(string file, string verb) {
    IntPtr pidl;
    var menu = MenuFor(file, out pidl);
    IntPtr hmenu = CreatePopupMenu();
    try {
      menu.QueryContextMenu(hmenu, 0, FIRST, LAST, 0);
      var list = new List<string[]>();
      Walk(menu, hmenu, "", list);
      string[] found = list.Find(e => e[0].Length > 0 && e[0] == verb) ?? list.Find(e => e[1] == verb);
      if (found == null) throw new Exception("Windows doesn't offer that for this file any more.");
      var info = new Invoke();
      info.cbSize = Marshal.SizeOf(typeof(Invoke));
      // The command by its position, which works whether or not it has a canonical name.
      info.lpVerb = (IntPtr)(int.Parse(found[2]) - (int)FIRST);
      info.nShow = 1;
      int hr = menu.InvokeCommand(ref info);
      if (hr != 0) throw new Exception("Windows couldn't do that (0x" + hr.ToString("X8") + ").");
    } finally { DestroyMenu(hmenu); Marshal.FreeCoTaskMem(pidl); }
  }
}
'@

$winrtCode = @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

/** Windows Runtime calls, by reflection: Windows PowerShell can't compile against them. */
public static class TheiaWinRT {
  [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDataTransferManagerInterop {
    IntPtr GetForWindow(IntPtr appWindow, ref Guid riid);
    void ShowShareUIForWindow(IntPtr appWindow);
  }
  static Type T(string name, string ns) { return Type.GetType(name + ", " + ns + ", ContentType=WindowsRuntime", true); }

  static object Await(object op, Type result) {
    var asTask = typeof(WindowsRuntimeSystemExtensions).GetMethods()
      .First(m => m.Name == "AsTask" && m.IsGenericMethod && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.Name.StartsWith("IAsyncOperation`"))
      .MakeGenericMethod(result);
    var task = (Task)asTask.Invoke(null, new[] { op });
    task.Wait();
    return task.GetType().GetProperty("Result").GetValue(task);
  }
  static void AwaitAction(object op) {
    var asTask = typeof(WindowsRuntimeSystemExtensions).GetMethods()
      .First(m => m.Name == "AsTask" && !m.IsGenericMethod && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.Name == "IAsyncAction");
    ((Task)asTask.Invoke(null, new[] { op })).Wait();
  }
  static object File(string path) {
    var type = T("Windows.Storage.StorageFile", "Windows.Storage");
    return Await(type.GetMethod("GetFileFromPathAsync").Invoke(null, new object[] { path }), type);
  }

  public static void SetLockScreen(string path) {
    var lockScreen = T("Windows.System.UserProfile.LockScreen", "Windows.System.UserProfile");
    AwaitAction(lockScreen.GetMethod("SetImageFileAsync").Invoke(null, new[] { File(path) }));
  }

  /* ---------------------------------------------------------------- share */

  public static string Status = "";
  static List<object> files;
  static string title;

  public static void OnRequested(object sender, object args) {
    var request = args.GetType().GetProperty("Request").GetValue(args);
    var data = request.GetType().GetProperty("Data").GetValue(request);
    var props = data.GetType().GetProperty("Properties").GetValue(data);
    props.GetType().GetProperty("Title").SetValue(props, title);
    var itemType = T("Windows.Storage.IStorageItem", "Windows.Storage");
    var list = Activator.CreateInstance(typeof(List<>).MakeGenericType(itemType));
    foreach (var f in files) list.GetType().GetMethod("Add").Invoke(list, new[] { f });
    data.GetType().GetMethods().First(m => m.Name == "SetStorageItems" && m.GetParameters().Length == 1).Invoke(data, new[] { list });
    if (Status == "") Status = "requested";
  }
  public static void OnChosen(object sender, object args) { Status = "chosen"; }

  static Delegate Handler(Type delegateType, string method) {
    var invoke = delegateType.GetMethod("Invoke");
    var ps = Enumerable.ToArray(Enumerable.Select(invoke.GetParameters(), p => Expression.Parameter(p.ParameterType)));
    var call = Expression.Call(typeof(TheiaWinRT).GetMethod(method), Enumerable.Select(ps, p => (Expression)Expression.Convert(p, typeof(object))));
    return Expression.Lambda(delegateType, call, ps).Compile();
  }
  /** A Windows Runtime event can only be joined through WindowsRuntimeMarshal. */
  static void Subscribe(Type type, object target, string name, string method) {
    var ev = type.GetEvent(name);
    var token = typeof(System.Runtime.InteropServices.WindowsRuntime.EventRegistrationToken);
    var add = Delegate.CreateDelegate(typeof(Func<,>).MakeGenericType(ev.EventHandlerType, token), target, ev.GetAddMethod());
    var remove = Delegate.CreateDelegate(typeof(Action<>).MakeGenericType(token), target, ev.GetRemoveMethod());
    typeof(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal).GetMethod("AddEventHandler")
      .MakeGenericMethod(ev.EventHandlerType).Invoke(null, new object[] { add, remove, Handler(ev.EventHandlerType, method) });
  }

  /** The share sheet for these files, owned by `hwnd`, a window of this process (Windows insists). */
  public static void Share(IntPtr hwnd, string[] paths, string name) {
    title = name;
    files = new List<object>();
    foreach (var p in paths) files.Add(File(p));
    var type = T("Windows.ApplicationModel.DataTransfer.DataTransferManager", "Windows.ApplicationModel.DataTransfer");
    var interop = (IDataTransferManagerInterop)System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal.GetActivationFactory(type);
    Guid iid = new Guid("a5caee9b-8708-49d1-8d36-67d25a8da00c");
    object manager = Marshal.GetObjectForIUnknown(interop.GetForWindow(hwnd, ref iid));
    Subscribe(type, manager, "DataRequested", "OnRequested");
    Subscribe(type, manager, "TargetApplicationChosen", "OnChosen");
    interop.ShowShareUIForWindow(hwnd);
  }
}
'@

try {
  switch ($Op) {
    'verbs' {
      Add-Type -TypeDefinition $shellCode
      $items = foreach ($e in [TheiaShellMenu]::List($Rest[0])) { @{ verb = $e[0]; label = $e[1] } }
      Say @{ ok = $true; verbs = @($items) }
    }
    'invoke' {
      Add-Type -TypeDefinition $shellCode
      [TheiaShellMenu]::Run($Rest[0], $Rest[1])
      Say @{ ok = $true }
    }
    'wallpaper' {
      Add-Type -TypeDefinition $shellCode
      # SPI_SETDESKWALLPAPER, written to the profile and announced to every window.
      if (-not [TheiaShellMenu]::SystemParametersInfo(20, 0, $Rest[0], 3)) { throw 'Windows did not accept the picture as the desktop background.' }
      Say @{ ok = $true }
    }
    'lockscreen' {
      Add-Type -ReferencedAssemblies @('System.Core', 'System.Runtime.WindowsRuntime') -TypeDefinition $winrtCode
      [TheiaWinRT]::SetLockScreen($Rest[0])
      Say @{ ok = $true }
    }
    'copy' {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $at = [Array]::IndexOf($Rest, 'image')
      $paths = if ($at -ge 0) { $Rest[0..($at - 1)] } else { $Rest }
      $data = New-Object Windows.Forms.DataObject
      $list = New-Object Collections.Specialized.StringCollection
      foreach ($p in $paths) { [void]$list.Add($p) }
      $data.SetFileDropList($list)
      if ($at -ge 0) {
        # Read whole, so the picture's file isn't held open afterwards.
        $bytes = [IO.File]::ReadAllBytes($Rest[$at + 1])
        $image = [Drawing.Image]::FromStream((New-Object IO.MemoryStream(,$bytes)))
        $data.SetImage($image)
      }
      [Windows.Forms.Clipboard]::SetDataObject($data, $true)
      Say @{ ok = $true }
    }
    'share' {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      Add-Type -ReferencedAssemblies @('System.Core', 'System.Runtime.WindowsRuntime') -TypeDefinition $winrtCode
      $at = [Array]::IndexOf($Rest, 'at')
      $paths = $Rest[0..($at - 1)]
      $x = [int]$Rest[$at + 1]; $y = [int]$Rest[$at + 2]; $parent = [int]$Rest[$at + 3]
      # Windows only shows the sheet for a window of the process asking. This one is
      # tiny, all but transparent, and sits over the middle of Theia's window.
      $form = New-Object Windows.Forms.Form
      $form.FormBorderStyle = 'None'; $form.ShowInTaskbar = $false; $form.StartPosition = 'Manual'
      $form.Size = New-Object Drawing.Size(2, 2); $form.Location = New-Object Drawing.Point($x, $y); $form.Opacity = 0.01
      $script:started = [DateTime]::UtcNow
      $script:chosenAt = $null
      $form.Add_Shown({
        try {
          $name = if ($paths.Count -eq 1) { [IO.Path]::GetFileName($paths[0]) } else { "$($paths.Count) photos" }
          [TheiaWinRT]::Share($form.Handle, [string[]]$paths, $name)
          Say @{ ok = $true }
        } catch {
          $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
          Say @{ error = $e.Message }; $form.Close(); return
        }
        $timer = New-Object Windows.Forms.Timer
        $timer.Interval = 1000
        $timer.Add_Tick({
          $now = [DateTime]::UtcNow
          if ([TheiaWinRT]::Status -eq 'chosen' -and -not $script:chosenAt) { $script:chosenAt = $now }
          $theiaGone = $parent -gt 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)
          # The app chosen reads the files from here: give it a minute.
          if ($theiaGone -or ($script:chosenAt -and ($now - $script:chosenAt).TotalSeconds -gt 60) -or ($now - $script:started).TotalMinutes -gt 10) { $form.Close() }
        })
        $timer.Start()
      })
      [Windows.Forms.Application]::Run($form)
    }
    default { throw "Unknown operation: $Op" }
  }
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  Say @{ error = $e.Message }
}
