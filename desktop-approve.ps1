# Answers the Claude desktop app's browser approval cards for one session, at the owner's tap in Telegram (hub.mjs,
# desktopApprove): "Allow Claude to act on <site>?" (Deny / Always allow / More allow options → Allow once) and "Allow
# Claude to execute JavaScript on <site>?" (Deny / Allow once). Brings the app window up, switches it to the session by its
# sidebar entry, reads the site from the card and clicks only when it is the expected host, with real mouse clicks (see
# Click). Prints one JSON line: { ok, url, kind, note }.
# usage: desktop-approve.ps1 -Title <session title> -Action once|always|deny -ExpectHost <host or ''>
param([string]$Title, [ValidateSet('once', 'always', 'deny')][string]$Action, [string]$ExpectHost = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.IntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint f);'
$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]
$script:kind = ''
function Out($ok, $url, $note) { if ($script:pinned) { [W.U]::SetWindowPos($script:pinned, [IntPtr](-2), 0, 0, 0, 0, 0x43) | Out-Null }; [Console]::Out.WriteLine((@{ ok = $ok; url = $url; kind = $script:kind; note = $note } | ConvertTo-Json -Compress)); exit 0 }
function ByName($root, $name) { $root.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name))) }
function Buttons($root, $name) { $root.FindAll($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))) | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1 }
function Press($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
# A real click (the app ignores UI Automation's Invoke on these buttons), only if the element under that point is the
# button itself or inside it: a window on top of it, or a background process denied the foreground, must not get the click.
function Click($el, $url) {
  if (-not $el) { Out $false $url 'no-button' }
  $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($try = 0; $try -lt 8; $try++) { # the switched-to session may still be laying out: re-measure until the point is the button
    $r = $el.Current.BoundingRectangle; $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    $at = $A::FromPoint((New-Object System.Windows.Point($x, $y)))
    for ($n = 0; $at -and $n -lt 6 -and -not [System.Windows.Automation.Automation]::Compare($at, $el); $n++) { $at = $walk.GetParent($at) } # the button or its label / shortcut chips
    if ($at -and [System.Windows.Automation.Automation]::Compare($at, $el)) {
      [W.U]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 80; [W.U]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); [W.U]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); return
    }
    Start-Sleep -Milliseconds 400
  }
  Out $false $url 'covered'
}

foreach ($w in $A::RootElement.FindAll($T::Children, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Claude')))) {
  $item = ByName $w $Title
  if (-not $item) { continue }
  # A background process (the hub) may not take the foreground, but it may put a window on top: pinned topmost while it
  # clicks (the click itself then activates it), unpinned on the way out.
  $h = [IntPtr]$w.Current.NativeWindowHandle; [W.U]::ShowWindow($h, 9) | Out-Null
  [W.U]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43) | Out-Null; [W.U]::SetForegroundWindow($h) | Out-Null
  $script:pinned = $h
  Press $item
  $card = $null
  for ($i = 0; $i -lt 20 -and -not $card; $i++) {
    Start-Sleep -Milliseconds 400
    $card = $w.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like 'Permission requested: *' } | Select-Object -First 1
  }
  if (-not $card) { Out $false '' 'no-card' }
  $text = $card.Current.Name
  $script:kind = if ($text -like 'Permission requested: execute JavaScript*') { 'js' } else { 'site' }
  # The site is its own text in the card's heading ("Allow Claude to <verb> on" · "shop.example.com" · "?"), with or without a scheme.
  $grp = $w.FindAll($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Group))) | Where-Object { $_.Current.Name -like 'Permission request: *' } | Select-Object -First 1
  $site = if ($grp) { $grp.FindAll($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))) | ForEach-Object { $_.Current.Name.Trim() } | Where-Object { $_ -match '^(https?://)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(/\S*)?$' } | Select-Object -First 1 }
  $url = if ($site) { $site } elseif ($text -match 'https?://[^\s",]+') { $Matches[0].TrimEnd('.') } else { '' }
  $siteHost = if ($url -match '^https?://') { ([Uri]$url).Host } else { ($url -split '/')[0] }
  if ($ExpectHost -and $siteHost -ne $ExpectHost) { Out $false $url 'host-mismatch' }
  Start-Sleep -Milliseconds 400 # let the switched-to session settle before clicking
  if ($Action -eq 'deny') { Click (Buttons $w 'Deny') $url; Out $true $url 'deny' }
  if ($Action -eq 'always') { $b = Buttons $w 'Always allow'; if (-not $b) { Out $false $url 'no-always' }; Click $b $url; Out $true $url 'always' }
  $once = Buttons $w 'Allow once' # the JavaScript card has it as a button; the site card hides it in a dropdown
  if (-not $once) {
    Click (Buttons $w 'More allow options') $url
    for ($i = 0; $i -lt 10 -and -not $once; $i++) {
      Start-Sleep -Milliseconds 300
      $once = $w.FindAll($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem))) | Where-Object { $_.Current.Name -eq 'Allow once' } | Select-Object -First 1
    }
  }
  if (-not $once) { Out $false $url 'no-allow-once' }
  Click $once $url
  Out $true $url 'once'
}
Out $false '' 'no-session'
