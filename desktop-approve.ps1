# Answers the Claude desktop app's site-approval card ("Allow Claude to act on <site>?") for one session, at the owner's
# tap in Telegram (hub.mjs, desktopApprove). Brings the app window up, switches it to the session by its sidebar entry,
# reads the site from the card and clicks only when it is the expected host, with real mouse clicks (see Click). Prints one JSON line: { ok, url, note }.
# usage: desktop-approve.ps1 -Title <session title> -Action once|always|deny -ExpectHost <host or ''>
param([string]$Title, [ValidateSet('once', 'always', 'deny')][string]$Action, [string]$ExpectHost = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.IntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'
$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]
function Out($ok, $url, $note) { [Console]::Out.WriteLine((@{ ok = $ok; url = $url; note = $note } | ConvertTo-Json -Compress)); exit 0 }
function ByName($root, $name) { $root.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name))) }
function Buttons($root, $name) { $root.FindAll($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))) | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1 }
function Press($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
# A real click (the app ignores UI Automation's Invoke on these buttons), only if the element under that point is the
# button itself: a window on top of it, or a background process denied the foreground, must not get the click.
function Click($el, $url) {
  $r = $el.Current.BoundingRectangle; $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  $at = $A::FromPoint((New-Object System.Windows.Point($x, $y))); $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($n = 0; $at -and $n -lt 6 -and -not [System.Windows.Automation.Automation]::Compare($at, $el); $n++) { $at = $walk.GetParent($at) } # the button or its label / shortcut chips
  if (-not $at -or -not [System.Windows.Automation.Automation]::Compare($at, $el)) { Out $false $url 'covered' }
  [W.U]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 80; [W.U]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); [W.U]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
}

foreach ($w in $A::RootElement.FindAll($T::Children, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Claude')))) {
  $item = ByName $w $Title
  if (-not $item) { continue }
  $h = [IntPtr]$w.Current.NativeWindowHandle; [W.U]::ShowWindow($h, 9) | Out-Null; [W.U]::SetForegroundWindow($h) | Out-Null
  Press $item
  $card = $null
  for ($i = 0; $i -lt 20 -and -not $card; $i++) {
    Start-Sleep -Milliseconds 400
    $card = $w.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like 'Permission requested: act on,*' } | Select-Object -First 1
  }
  if (-not $card) { Out $false '' 'no-card' }
  $url = ($card.Current.Name -replace '^Permission requested: act on,\s*', '') -replace '\.\s.*$', ''
  if ($ExpectHost -and ([Uri]$url).Host -ne $ExpectHost) { Out $false $url 'host-mismatch' }
  Start-Sleep -Milliseconds 400 # let the switched-to session settle before clicking
  if ($Action -eq 'deny') { Click (Buttons $w 'Deny') $url; Out $true $url 'deny' }
  if ($Action -eq 'always') { Click (Buttons $w 'Always allow') $url; Out $true $url 'always' }
  Click (Buttons $w 'More allow options') $url
  $once = $null
  for ($i = 0; $i -lt 10 -and -not $once; $i++) {
    Start-Sleep -Milliseconds 300
    $once = $w.FindAll($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem))) | Where-Object { $_.Current.Name -eq 'Allow once' } | Select-Object -First 1
  }
  if (-not $once) { Out $false $url 'no-allow-once' }
  Click $once $url
  Out $true $url 'once'
}
Out $false '' 'no-session'
