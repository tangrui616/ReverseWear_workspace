using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class WindowsBridge
{
    private const int WmClipboardUpdate = 0x031D;
    private const uint CfHdrop = 15;
    private const uint GmemMoveable = 0x0002;
    private const uint GmemZeroInit = 0x0040;
    private const int ModControl = 0x11;
    private const int ModShift = 0x10;
    private const int ModAlt = 0x12;
    private const int ModLWin = 0x5B;
    private const int ModRWin = 0x5C;
    private const uint InputKeyboard = 1;
    private const uint KeyUp = 0x0002;
    private const ushort VkControl = 0x11;
    private const ushort VkV = 0x56;
    private static readonly object OutputLock = new object();
    private static readonly object ClipboardLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    private static TextReader InputReader;
    private static TextWriter OutputWriter;
    private static readonly uint CanIncludeInClipboardHistory = RegisterClipboardFormat("CanIncludeInClipboardHistory");
    private static readonly uint CanUploadToCloudClipboard = RegisterClipboardFormat("CanUploadToCloudClipboard");
    private static readonly uint ExcludeClipboardContentFromMonitorProcessing = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");

    [STAThread]
    private static int Main()
    {
        var utf8 = new UTF8Encoding(false);
        InputReader = new StreamReader(Console.OpenStandardInput(), utf8);
        OutputWriter = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true };
        var listener = new Thread(() => Application.Run(new ListenerContext()));
        listener.IsBackground = true;
        listener.SetApartmentState(ApartmentState.STA);
        listener.Start();

        string line;
        while ((line = InputReader.ReadLine()) != null)
        {
            Dictionary<string, object> request = null;
            if (line.Length > 65536)
            {
                Write(new Dictionary<string, object> { { "id", null }, { "error", "Request exceeds 64 KiB." } });
                continue;
            }
            try
            {
                request = Json.Deserialize<Dictionary<string, object>>(line);
                object result = Dispatch(request);
                Write(new Dictionary<string, object> { { "id", request.ContainsKey("id") ? request["id"] : null }, { "result", result } });
            }
            catch (Exception error)
            {
                Write(new Dictionary<string, object> { { "id", request != null && request.ContainsKey("id") ? request["id"] : null }, { "error", error.Message } });
            }
        }
        return 0;
    }

    private static object Dispatch(Dictionary<string, object> request)
    {
        object rawCommand;
        if (!request.TryGetValue("command", out rawCommand)) throw new InvalidDataException("Command is required.");
        var command = Convert.ToString(rawCommand);
        if (command == "snapshot") return Snapshot();
        if (command == "focus") return Focus(request);
        if (command == "paste") return Paste(request);
        if (command == "copy") return Copy(request);
        if (command == "setFiles") return SetFiles(request);
        if (command == "selection") return Selection();
        throw new InvalidDataException("Unknown command.");
    }

    private static object Snapshot()
    {
        var sequence = GetClipboardSequenceNumber();
        var owner = GetClipboardOwner();
        var foreground = GetForegroundWindow();
        var blocked = true;
        var files = new string[0];
        if (WaitForClipboard())
        {
            try
            {
                sequence = GetClipboardSequenceNumber();
                owner = GetClipboardOwner();
                blocked = ClipboardMarkedPrivate();
                if (!blocked) files = ReadOpenClipboardFiles();
                if (GetClipboardSequenceNumber() != sequence) blocked = true;
            }
            finally { CloseClipboard(); }
        }
        uint ownerPid;
        GetWindowThreadProcessId(owner, out ownerPid);
        return new Dictionary<string, object> {
            { "sequence", sequence }, { "owner", ProcessInfo(owner) },
            { "foreground", ProcessInfo(foreground) }, { "privacyExcluded", blocked },
            { "helperWrite", ownerPid == (uint)Process.GetCurrentProcess().Id }, { "files", blocked ? new string[0] : files }
        };
    }

    private static object ProcessInfo(IntPtr window)
    {
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        var result = new Dictionary<string, object> { { "hwnd", window.ToInt64() }, { "pid", pid }, { "processName", "" }, { "executable", "" } };
        if (window == IntPtr.Zero || pid == 0) return result;
        try
        {
            using (var process = Process.GetProcessById((int)pid))
            {
                result["processName"] = process.ProcessName + ".exe";
                try { result["executable"] = process.MainModule.FileName; } catch { }
            }
        }
        catch { }
        return result;
    }

    private static string[] ReadOpenClipboardFiles()
    {
        if (!IsClipboardFormatAvailable(CfHdrop)) return new string[0];
        var drop = GetClipboardData(CfHdrop);
        if (drop == IntPtr.Zero) return new string[0];
        uint count = DragQueryFile(drop, 0xFFFFFFFF, null, 0);
        if (count > 256) return new string[0];
        var paths = new List<string>();
        for (uint index = 0; index < count; index++)
        {
            uint length = DragQueryFile(drop, index, null, 0);
            if (length == 0 || length > 32767) continue;
            var buffer = new StringBuilder((int)length + 1);
            if (DragQueryFile(drop, index, buffer, (uint)buffer.Capacity) > 0) paths.Add(buffer.ToString());
        }
        return paths.ToArray();
    }

    private static bool? ClipboardHasFlag(uint format, int expected)
    {
        if (format == 0) return null;
        if (!IsClipboardFormatAvailable(format)) return false;
        var memory = GetClipboardData(format);
        if (memory == IntPtr.Zero || GlobalSize(memory).ToUInt64() < sizeof(int)) return null;
        var pointer = GlobalLock(memory);
        if (pointer == IntPtr.Zero) return null;
        try
        {
            var value = Marshal.ReadInt32(pointer);
            if (value == expected) return true;
            if (value == (expected == 0 ? 1 : 0)) return false;
            return null;
        }
        finally { GlobalUnlock(memory); }
    }

    private static object Paste(Dictionary<string, object> request)
    {
        var hwnd = RequiredLong(request, "foregroundHwnd");
        var pid = RequiredLong(request, "pid");
        var sequence = RequiredLong(request, "sequence");
        if (GetForegroundWindow().ToInt64() != hwnd) return Failure("The original foreground window is no longer active.");
        uint currentPid;
        GetWindowThreadProcessId(new IntPtr(hwnd), out currentPid);
        if (currentPid != (uint)pid) return Failure("The original foreground process changed.");
        if (GetClipboardSequenceNumber() != (uint)sequence) return Failure("The clipboard changed before paste.");
        if (!WaitForModifiersToRelease()) return Failure("Release the shortcut keys before pasting.");
        if (GetForegroundWindow().ToInt64() != hwnd || GetClipboardSequenceNumber() != (uint)sequence)
            return Failure("The active window or clipboard changed while waiting for the shortcut keys to release.");
        GetWindowThreadProcessId(new IntPtr(hwnd), out currentPid);
        if (currentPid != (uint)pid) return Failure("The original foreground process changed.");

        var inputs = new[] {
            Key(VkControl, false), Key(VkV, false), Key(VkV, true), Key(VkControl, true)
        };
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
            return Failure("Windows did not accept the paste keystroke.");
        return new Dictionary<string, object> { { "ok", true } };
    }

    private static object Copy(Dictionary<string, object> request)
    {
        var hwnd = new IntPtr(RequiredLong(request, "foregroundHwnd"));
        var pid = RequiredLong(request, "pid");
        var expectedSequence = RequiredLong(request, "sequence");
        if (!IsExpectedForeground(hwnd, (uint)pid)) return Failure("The original foreground window is no longer active.");
        if (GetClipboardSequenceNumber() != (uint)expectedSequence) return Failure("The clipboard changed before selection copy.");
        if (!WaitForModifiersToRelease()) return Failure("Release the shortcut keys before reading a selection.");
        if (!IsExpectedForeground(hwnd, (uint)pid) || GetClipboardSequenceNumber() != (uint)expectedSequence)
            return Failure("The active window or clipboard changed while waiting for the shortcut keys to release.");
        try
        {
            var focused = AutomationElement.FocusedElement;
            if (focused == null || focused.Current.IsPassword) return Failure("The active field cannot be copied safely.");
        }
        catch (ElementNotAvailableException) { return Failure("The active field cannot be copied safely."); }

        uint originalSequence;
        List<ClipboardBlock> original;
        string error;
        if (!TrySnapshotClipboard((uint)expectedSequence, out originalSequence, out original, out error)) return Failure(error);
        if (!IsExpectedForeground(hwnd, (uint)pid) || GetClipboardSequenceNumber() != originalSequence)
            return Failure("The active window or clipboard changed before selection copy.");

        var keys = new[] { Key(VkControl, false), Key(0x43, false), Key(0x43, true), Key(VkControl, true) };
        if (SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(Input))) != keys.Length)
            return Failure("Windows did not accept the copy keystroke.");

        uint copiedSequence = originalSequence;
        string copiedText = null;
        var deadline = DateTime.UtcNow.AddMilliseconds(750);
        while (DateTime.UtcNow < deadline)
        {
            copiedSequence = GetClipboardSequenceNumber();
            if (copiedSequence != originalSequence)
            {
                if (!IsExpectedForeground(hwnd, (uint)pid) || OwnerPid() != (uint)pid) break;
                uint readSequence;
                copiedText = ReadUnicodeClipboardText(copiedSequence, (uint)pid, out readSequence);
                if (copiedText != null)
                {
                    copiedSequence = readSequence;
                    break;
                }
            }
            Thread.Sleep(25);
        }

        var restored = copiedSequence != originalSequence && TryRestoreClipboard(copiedSequence, hwnd, (uint)pid, original);
        if (String.IsNullOrWhiteSpace(copiedText))
            return Failure(restored ? "The application did not provide selected plain text." :
                "Selected text was unavailable, or the clipboard changed and could not be safely restored.");
        if (!restored) return Failure("Selection was copied, but the original clipboard could not be safely restored.");
        return new Dictionary<string, object> {
            { "ok", true }, { "text", copiedText }, { "sequence", GetClipboardSequenceNumber() },
            { "foreground", ProcessInfo(GetForegroundWindow()) }, { "clipboardRestored", true }
        };
    }

    private static bool IsExpectedForeground(IntPtr hwnd, uint expectedPid)
    {
        if (hwnd == IntPtr.Zero || GetForegroundWindow() != hwnd || !IsWindow(hwnd)) return false;
        uint actualPid;
        GetWindowThreadProcessId(hwnd, out actualPid);
        return actualPid == expectedPid;
    }

    private static bool HasPressedModifier()
    {
        foreach (var key in new[] { ModControl, ModShift, ModAlt, ModLWin, ModRWin })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
        return false;
    }

    private static bool WaitForModifiersToRelease()
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(1000);
        while (HasPressedModifier() && DateTime.UtcNow < deadline) Thread.Sleep(10);
        return !HasPressedModifier();
    }

    private static uint OwnerPid()
    {
        uint pid;
        GetWindowThreadProcessId(GetClipboardOwner(), out pid);
        return pid;
    }

    private static bool ClipboardMarkedPrivate()
    {
        return ClipboardHasFlag(CanIncludeInClipboardHistory, 0) != false ||
               ClipboardHasFlag(CanUploadToCloudClipboard, 0) != false ||
               ExcludeClipboardContentFromMonitorProcessing == 0 ||
               IsClipboardFormatAvailable(ExcludeClipboardContentFromMonitorProcessing);
    }

    private static bool TrySnapshotClipboard(uint expectedSequence, out uint sequence, out List<ClipboardBlock> blocks, out string error)
    {
        blocks = new List<ClipboardBlock>();
        error = "";
        sequence = GetClipboardSequenceNumber();
        if (sequence != expectedSequence) { error = "The clipboard changed before it could be preserved."; return false; }
        if (!WaitForClipboard(expectedSequence)) { error = "The clipboard changed or is busy. Try again."; return false; }
        try
        {
            sequence = GetClipboardSequenceNumber();
            if (sequence != expectedSequence) { error = "The clipboard changed before it could be preserved."; return false; }
            if (ClipboardMarkedPrivate()) { error = "The current clipboard may contain private content."; return false; }
            uint previous = 0;
            ulong totalBytes = 0;
            int count;
            for (count = 0; count < 256; count++)
            {
                uint format = EnumClipboardFormats(previous);
                if (format == 0) break;
                previous = format;
                var handle = GetClipboardData(format);
                if (handle == IntPtr.Zero) { error = "One clipboard format cannot be preserved safely."; return false; }
                ulong size = GlobalSize(handle).ToUInt64();
                if (size == 0 || size > 64UL * 1024 * 1024 || totalBytes + size > 64UL * 1024 * 1024)
                { error = "The clipboard contains a format that exceeds the safe preservation limit."; return false; }
                var memory = GlobalLock(handle);
                if (memory == IntPtr.Zero) { error = "A clipboard format could not be read safely."; return false; }
                try
                {
                    var bytes = new byte[(int)size];
                    Marshal.Copy(memory, bytes, 0, bytes.Length);
                    blocks.Add(new ClipboardBlock { Format = format, Bytes = bytes });
                    totalBytes += size;
                }
                finally { GlobalUnlock(handle); }
            }
            if (count == 256) { error = "The clipboard contains too many formats to preserve safely."; return false; }
            if (GetClipboardSequenceNumber() != expectedSequence) { error = "The clipboard changed while it was being preserved."; return false; }
            return true;
        }
        finally { CloseClipboard(); }
    }

    private static string ReadUnicodeClipboardText(uint expectedSequence, uint expectedPid, out uint readSequence)
    {
        const uint CfUnicodeText = 13;
        readSequence = expectedSequence;
        if (!IsClipboardFormatAvailable(CfUnicodeText) || !OpenClipboard(ListenerWindow.CurrentHandle)) return null;
        try
        {
            if (GetClipboardSequenceNumber() != expectedSequence || OwnerPid() != expectedPid || ClipboardMarkedPrivate()) return null;
            var handle = GetClipboardData(CfUnicodeText);
            if (handle == IntPtr.Zero) return null;
            var size = GlobalSize(handle).ToUInt64();
            if (size < 2 || size > 2UL * 1024 * 1024) return null;
            var memory = GlobalLock(handle);
            if (memory == IntPtr.Zero) return null;
            try
            {
                var text = Marshal.PtrToStringUni(memory, (int)(size / 2)).TrimEnd('\0');
                readSequence = GetClipboardSequenceNumber();
                return text;
            }
            finally { GlobalUnlock(handle); }
        }
        finally { CloseClipboard(); }
    }

    private static bool TryRestoreClipboard(uint expectedSequence, IntPtr hwnd, uint pid, List<ClipboardBlock> blocks)
    {
        if (!IsExpectedForeground(hwnd, pid) || !WaitForClipboard(expectedSequence)) return false;
        var allocations = new List<IntPtr>();
        try
        {
            if (GetClipboardSequenceNumber() != expectedSequence || OwnerPid() != pid || !IsExpectedForeground(hwnd, pid)) return false;
            foreach (var block in blocks)
            {
                var allocation = GlobalAlloc(GmemMoveable | GmemZeroInit, new UIntPtr((uint)block.Bytes.Length));
                if (allocation == IntPtr.Zero) return false;
                allocations.Add(allocation);
                var memory = GlobalLock(allocation);
                if (memory == IntPtr.Zero) return false;
                try { Marshal.Copy(block.Bytes, 0, memory, block.Bytes.Length); }
                finally { GlobalUnlock(allocation); }
            }
            if (!EmptyClipboard()) return false;
            foreach (var block in blocks)
            {
                var allocation = allocations[0];
                if (SetClipboardData(block.Format, allocation) == IntPtr.Zero) return false;
                allocations.RemoveAt(0);
            }
            return true;
        }
        finally
        {
            CloseClipboard();
            foreach (var allocation in allocations) GlobalFree(allocation);
        }
    }

    private static object Focus(Dictionary<string, object> request)
    {
        var hwnd = new IntPtr(RequiredLong(request, "foregroundHwnd"));
        var pid = RequiredLong(request, "pid");
        var allowedCurrent = new IntPtr(RequiredLong(request, "allowedCurrentHwnd"));
        uint currentPid;
        var current = GetForegroundWindow();
        GetWindowThreadProcessId(hwnd, out currentPid);
        if (currentPid != (uint)pid || !IsWindow(hwnd)) return Failure("The original foreground window is no longer available.");
        if (current != hwnd && current != allowedCurrent) return Failure("Focus moved to another application. Automatic focus restoration was skipped.");
        if (current != hwnd) SetForegroundWindow(hwnd);
        var focused = GetForegroundWindow() == hwnd;
        uint focusedPid;
        GetWindowThreadProcessId(GetForegroundWindow(), out focusedPid);
        return new Dictionary<string, object> { { "ok", focused }, { "foregroundHwnd", GetForegroundWindow().ToInt64() }, { "pid", focusedPid } };
    }

    private static object SetFiles(Dictionary<string, object> request)
    {
        object raw;
        if (!request.TryGetValue("paths", out raw)) throw new InvalidDataException("Paths are required.");
        var paths = raw as IList;
        if (paths == null || paths.Count == 0 || paths.Count > 256) throw new InvalidDataException("Provide between 1 and 256 file paths.");
        var values = new List<string>();
        foreach (var item in paths)
        {
            var path = item as string;
            if (String.IsNullOrWhiteSpace(path) || path.IndexOf('\0') >= 0 || path.Length > 32767) throw new InvalidDataException("Invalid file path.");
            values.Add(Path.GetFullPath(path));
        }

        var payload = Encoding.Unicode.GetBytes(String.Join("\0", values) + "\0\0");
        int headerSize = Marshal.SizeOf(typeof(DropFiles));
        var allocation = GlobalAlloc(GmemMoveable | GmemZeroInit, new UIntPtr((uint)(headerSize + payload.Length)));
        if (allocation == IntPtr.Zero) throw new InvalidOperationException("Could not allocate a Windows file-list clipboard block.");
        var memory = GlobalLock(allocation);
        if (memory == IntPtr.Zero) { GlobalFree(allocation); throw new InvalidOperationException("Could not lock a Windows file-list clipboard block."); }
        Marshal.StructureToPtr(new DropFiles { pFiles = (uint)headerSize, fWide = 1 }, memory, false);
        Marshal.Copy(payload, 0, IntPtr.Add(memory, headerSize), payload.Length);
        GlobalUnlock(allocation);

        if (!WaitForClipboard(GetClipboardSequenceNumber())) { GlobalFree(allocation); throw new InvalidOperationException("The clipboard changed or is busy."); }
        try
        {
            if (!EmptyClipboard() || SetClipboardData(CfHdrop, allocation) == IntPtr.Zero)
            {
                GlobalFree(allocation);
                throw new InvalidOperationException("Could not write the file list to the clipboard.");
            }
        }
        finally { CloseClipboard(); }
        return Snapshot();
    }

    private static object Selection()
    {
        var foreground = GetForegroundWindow();
        try
        {
            var element = AutomationElement.FocusedElement;
            if (element == null) return Failure("No accessible focused control.");
            if (element.Current.IsPassword) return Failure("Password fields are excluded from selection tools.");
            object pattern;
            if (!element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return Failure("The active application does not expose a text selection.");
            var ranges = ((TextPattern)pattern).GetSelection();
            if (ranges == null || ranges.Length == 0) return Failure("No text is selected.");
            var text = String.Join("\n", Array.ConvertAll(ranges, range => range.GetText(100000)));
            if (String.IsNullOrWhiteSpace(text)) return Failure("No text is selected.");
            if (text.Length > 100000) return Failure("The selected text is too large.");
            if (GetForegroundWindow() != foreground) return Failure("The active application changed while reading the selection.");
            return new Dictionary<string, object> { { "ok", true }, { "text", text }, { "foreground", ProcessInfo(foreground) }, { "sequence", GetClipboardSequenceNumber() } };
        }
        catch (ElementNotAvailableException) { return Failure("The active selection is no longer available."); }
        catch (InvalidOperationException error) { return Failure(error.Message); }
        catch (COMException error) { return Failure(error.Message); }
    }

    private static object Failure(string message) { return new Dictionary<string, object> { { "ok", false }, { "error", message } }; }
    private static long RequiredLong(Dictionary<string, object> request, string key)
    {
        object value;
        long parsed;
        if (!request.TryGetValue(key, out value) || !Int64.TryParse(Convert.ToString(value), out parsed) || parsed < 0)
            throw new InvalidDataException("Invalid " + key + ".");
        return parsed;
    }

    private static Input Key(ushort virtualKey, bool keyUp)
    {
        return new Input { type = InputKeyboard, data = new InputUnion { keyboard = new KeyboardInput { virtualKey = virtualKey, flags = keyUp ? KeyUp : 0 } } };
    }

    private static void Write(object value)
    {
        lock (OutputLock) { OutputWriter.WriteLine(Json.Serialize(value)); OutputWriter.Flush(); }
    }

    private sealed class ListenerContext : ApplicationContext
    {
        private readonly ListenerWindow window;
        public ListenerContext() { window = new ListenerWindow(); }
        protected override void Dispose(bool disposing) { if (disposing) window.Dispose(); base.Dispose(disposing); }
    }

    private sealed class ClipboardBlock { public uint Format; public byte[] Bytes; }

    private sealed class ListenerWindow : NativeWindow, IDisposable
    {
        public static IntPtr CurrentHandle;
        public ListenerWindow()
        {
            var parameters = new CreateParams { Caption = "ReverseWear Clipboard Listener", Parent = new IntPtr(-3) };
            CreateHandle(parameters);
            if (!AddClipboardFormatListener(Handle)) throw new InvalidOperationException("Could not register the Windows clipboard listener.");
            CurrentHandle = Handle;
            Write(new Dictionary<string, object> { { "event", "ready" } });
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmClipboardUpdate)
            {
                try { var snapshot = Snapshot() as Dictionary<string, object>; snapshot["event"] = "clipboard-changed"; Write(snapshot); } catch { }
            }
            base.WndProc(ref message);
        }
        public void Dispose() { if (Handle != IntPtr.Zero) { RemoveClipboardFormatListener(Handle); DestroyHandle(); CurrentHandle = IntPtr.Zero; } }
    }

    [StructLayout(LayoutKind.Sequential)] private struct DropFiles { public uint pFiles; public int x; public int y; public int fNC; public int fWide; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion
    {
        [FieldOffset(0)] public KeyboardInput keyboard;
        [FieldOffset(0)] public MouseInput mouse;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput
    {
        public int x, y;
        public uint mouseData, flags, time;
        public IntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public IntPtr extraInfo; }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int virtualKey);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    private static bool WaitForClipboard(uint? expectedSequence = null)
    {
        for (int attempt = 0; attempt < 5; attempt++)
        {
            if (expectedSequence.HasValue && GetClipboardSequenceNumber() != expectedSequence.Value) return false;
            if (OpenClipboard(ListenerWindow.CurrentHandle))
            {
                if (!expectedSequence.HasValue || GetClipboardSequenceNumber() == expectedSequence.Value) return true;
                CloseClipboard();
                return false;
            }
            if (attempt < 4) Thread.Sleep(20);
        }
        return false;
    }

    private static bool OpenClipboard(IntPtr owner)
    {
        Monitor.Enter(ClipboardLock);
        if (NativeOpenClipboard(owner)) return true;
        Monitor.Exit(ClipboardLock);
        return false;
    }
    private static bool CloseClipboard()
    {
        try { return NativeCloseClipboard(); }
        finally { Monitor.Exit(ClipboardLock); }
    }
    [DllImport("user32.dll", EntryPoint = "OpenClipboard", SetLastError = true)] private static extern bool NativeOpenClipboard(IntPtr owner);
    [DllImport("user32.dll", EntryPoint = "CloseClipboard", SetLastError = true)] private static extern bool NativeCloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint EnumClipboardFormats(uint previousFormat);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern uint DragQueryFile(IntPtr drop, uint index, StringBuilder path, uint capacity);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr memory);
}
