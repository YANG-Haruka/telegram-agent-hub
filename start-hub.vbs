' Starts the Agent Hub without a console window and keeps it running: when the hub exits asking for a restart
' (exit code <> 0: update, restart.flag, watchdog, crash) it is started again after 5 s. Task Scheduler's own
' "restart on failure" does not fire for a non-zero exit code, so the loop lives here. Exit code 0 = stopped on purpose,
' 3 = another hub is already running (try again in 60 s), 4 = planned restart. node's stderr goes to logs\crash.log (crashes before the hub's own log).
' 3 crashes in a row within 2 minutes of starting = a bad hub.mjs: put back good\hub.mjs (the hub saves it after 2 stable
' minutes; dependencies are not touched; the crashed file is kept as logs\hub.mjs.crashed) and wait 60 s between further quick crashes.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists("logs") Then fso.CreateFolder "logs"
fails = 0
Do
  t0 = Timer
  rc = sh.Run("cmd /c """"C:\Program Files\nodejs\node.exe"" hub.mjs 2>>logs\crash.log""", 0, True)
  If rc = 0 Then Exit Do
  ' Timer wraps at midnight: a negative difference is treated as a long run.
  ' 4 = planned restart (restart.flag, update): never a crash, even right after starting.
  If rc <> 3 And rc <> 4 And Timer - t0 >= 0 And Timer - t0 < 120 Then fails = fails + 1 Else fails = 0
  If fails = 3 And fso.FileExists("good\hub.mjs") Then
    fso.CopyFile "hub.mjs", "logs\hub.mjs.crashed", True
    fso.CopyFile "good\hub.mjs", "hub.mjs", True
    Set f = fso.OpenTextFile("logs\crash.log", 8, True): f.WriteLine Now & " start-hub: 3 quick crashes, restored good\hub.mjs (bad one: logs\hub.mjs.crashed)": f.Close
  End If
  If rc = 3 Or fails >= 3 Then WScript.Sleep 60000 Else WScript.Sleep 5000
Loop
WScript.Quit rc
