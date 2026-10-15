' Starts the Agent Hub without a console window and waits for it, so Task Scheduler sees the exit code.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WScript.Quit sh.Run("""C:\Program Files\nodejs\node.exe"" hub.mjs", 0, True)
