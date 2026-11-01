' AiWindowsAssistant
' Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
' GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
'
' Starts AiWindowsAssistant.exe (next to this file) without a console window. Used by the Start
' menu / desktop shortcuts and the "start with Windows" entry the installer creates.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run """" & dir & "\AiWindowsAssistant.exe""", 0, False
