Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point p);
'@ -ReferencedAssemblies System.Drawing
$h = [W.U]::GetForegroundWindow()
$pid2 = 0
[void][W.U]::GetWindowThreadProcessId($h, [ref]$pid2)
$sb = New-Object System.Text.StringBuilder 256
[void][W.U]::GetWindowText($h, $sb, 256)
$p = New-Object System.Drawing.Point
[void][W.U]::GetCursorPos([ref]$p)
@{ hwnd = [int64]$h; pid = $pid2; title = $sb.ToString(); cursor = @{ x = $p.X; y = $p.Y } } | ConvertTo-Json -Compress
