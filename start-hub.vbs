' Starts the Agent Hub without a console window and keeps it running: when the hub exits asking for a restart
' (exit code <> 0: update, restart.flag, watchdog, crash) it is started again after 5 s. Task Scheduler's own
' "restart on failure" does not fire for a non-zero exit code, so the loop lives here. Exit code 0 = stopped on purpose.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Do
  rc = sh.Run("""C:\Program Files\nodejs\node.exe"" hub.mjs", 0, True)
  If rc = 0 Then Exit Do
  WScript.Sleep 5000
Loop
WScript.Quit rc
