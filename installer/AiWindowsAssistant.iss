; AiWindowsAssistant — Windows installer (Inno Setup 6)
; Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
; GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
;
; Built by scripts/installer-build.js (npm run installer) after npm run pkg-build.
; Per-user install (no administrator rights needed) into %LOCALAPPDATA%\Programs\AiWindowsAssistant:
; the app keeps its settings (.env), database and logs next to the exe, so its folder must be
; writable by the user. The optional administrator helper is installed with a single UAC prompt.

#ifndef MyAppVersion
  #define MyAppVersion "1.5.0"
#endif
#define MyAppName "AiWindowsAssistant"
#define MyAppExe "AiWindowsAssistant.exe"
#define MyAppURL "https://github.com/jorodriguezpr/aiwindowsassistant"

[Setup]
AppId={{B671EA68-CB4A-43B6-987D-B8F9FFD65B2D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=Micro Computer Repair Services
AppPublisherURL=http://www.microrepair.net
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
AppCopyright=Copyright (c) Jose Rodriguez Arroyo
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\pkg-dist
OutputBaseFilename=AiWindowsAssistant-Setup-{#MyAppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\assets\icon.ico
UninstallDisplayName={#MyAppName}
LicenseFile=..\LICENSE
; the SysAiBrain avatar's own terms (use only inside AiWindowsAssistant), shown before installing
InfoBeforeFile=..\SYSAIBRAIN-AVATAR-LICENSE.txt
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=no
UsedUserAreasWarning=no
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany=Micro Computer Repair Services
VersionInfoDescription={#MyAppName} Setup

[Tasks]
Name: "autostart"; Description: "Start AiWindowsAssistant when I sign in to Windows"
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
Name: "assistantengine"; Description: "Use Ollama Cloud (the assistant's own engine) instead of Claude Code for my tasks and delegated work — you can switch back any time with /engine and /workers"; Flags: unchecked
Name: "adminhelper"; Description: "Install the administrator helper (Windows updates, BitLocker, repairs, silent app installs) — Windows asks for permission once"; Flags: unchecked; Check: not HelperInstalled
Name: "adminhelperupdate"; Description: "Update the administrator helper to this version (Windows asks for permission once)"; Check: HelperInstalled

[Files]
Source: "..\pkg-dist\{#MyAppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "AiWindowsAssistant.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\assets\icon.ico"; DestDir: "{app}\assets"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\SYSAIBRAIN-AVATAR-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
; SysAiBrain avatar: commercial, binary pack only (scripts/avatar-pack.js) — https://sysaibrain.com
Source: "..\assets\sysaibrain\avatar.bin"; DestDir: "{app}\assets\sysaibrain"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{userprograms}\{#MyAppName}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\AiWindowsAssistant.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Comment: "Start AiWindowsAssistant"
Name: "{userprograms}\{#MyAppName}\Settings (.env)"; Filename: "{win}\notepad.exe"; Parameters: """{app}\.env"""; IconFilename: "{app}\assets\icon.ico"
Name: "{userprograms}\{#MyAppName}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\AiWindowsAssistant.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AiWindowsAssistant"; ValueData: "wscript.exe ""{app}\AiWindowsAssistant.vbs"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExe}"; Parameters: "--protect-secrets"; WorkingDir: "{app}"; StatusMsg: "Encrypting your secrets with Windows..."; Flags: runhidden waituntilterminated; Check: EnvWritten
Filename: "{app}\{#MyAppExe}"; Parameters: "--install-helper"; WorkingDir: "{app}"; Verb: "runas"; StatusMsg: "Installing the administrator helper..."; Flags: shellexec runhidden waituntilterminated; Tasks: adminhelper adminhelperupdate
Filename: "{sys}\wscript.exe"; Parameters: """{app}\AiWindowsAssistant.vbs"""; WorkingDir: "{app}"; Description: "Start AiWindowsAssistant now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\{#MyAppExe}"; Parameters: "--uninstall-cleanup"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "Cleanup"
Filename: "{app}\{#MyAppExe}"; Parameters: "--uninstall-helper"; WorkingDir: "{app}"; Verb: "runas"; Flags: shellexec runhidden waituntilterminated; RunOnceId: "Helper"; Check: HelperInstalled

[Code]
var
  TelegramPage: TInputQueryWizardPage;
  AiPage: TInputOptionWizardPage;
  KeyPage: TInputQueryWizardPage;
  WorkPage: TInputDirWizardPage;
  EnvWasThere, EnvDone: Boolean;

function HelperInstalled: Boolean;
begin
  Result := DirExists(ExpandConstant('{commonappdata}\AiWindowsAssistant\helper'));
end;

function EnvWritten: Boolean;
begin
  Result := EnvDone;
end;

function ClaudeCodeFound: Boolean;
begin
  Result := FileExists(ExpandConstant('{userappdata}\npm\claude.cmd')) or
            FileExists(ExpandConstant('{localappdata}\Programs\claude\claude.exe')) or
            FileExists(ExpandConstant('{%USERPROFILE}\.local\bin\claude.exe'));
end;

procedure KillRunningApp;
var
  Code: Integer;
begin
  // the running assistant (normal user); an elevated helper copy elsewhere is not affected
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im {#MyAppExe}', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure InitializeWizard;
begin
  TelegramPage := CreateInputQueryPage(wpSelectTasks,
    'Telegram', 'Connect your Telegram bot',
    'You talk to the assistant through your own Telegram bot. In Telegram, open @BotFather, send /newbot and paste the token it gives you below.' + #13#10 + #13#10 +
    'Your chat ID: leave it empty if you don''t know it. After installing, send /start to your bot: it answers with your chat ID. Put it in Start menu > AiWindowsAssistant > Settings (TELEGRAM_ALLOWED_USERS) and start the assistant again. Until then the bot answers nobody (safe by default).');
  TelegramPage.Add('Bot token (from @BotFather):', False);
  TelegramPage.Add('Your Telegram chat ID (optional):', False);

  AiPage := CreateInputOptionPage(TelegramPage.ID,
    'AI', 'Which AI should the assistant use?',
    'By default Claude Code does the work (install it separately and sign in once — it is not part of this installer). ' +
    'The AI below is the assistant''s own engine: used for /ai, and for everything if you ticked "Use Ollama Cloud instead of Claude Code" on the previous page.', True, False);
  AiPage.Add('Ollama Cloud (needs an API key from ollama.com)');
  AiPage.Add('Anthropic API (needs an API key)');
  AiPage.Add('Ollama on this PC (no key)');
  AiPage.SelectedValueIndex := 0;

  KeyPage := CreateInputQueryPage(AiPage.ID,
    'AI', 'API key', 'Paste the API key for the AI service you chose. It is stored encrypted with Windows (only your user on this PC can read it). You can leave it empty and add it later in Settings.');
  KeyPage.Add('API key:', True);

  WorkPage := CreateInputDirPage(KeyPage.ID,
    'Workspace', 'Which folder may the assistant work in?',
    'Claude Code may create and edit files freely inside this folder. Outside it, the assistant asks you first. Protected places (passwords, keys, browser data) are always blocked.',
    False, '');
  WorkPage.Add('');
  WorkPage.Values[0] := ExpandConstant('{userdocs}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  // upgrade: the settings are already there — keep them
  if (PageID = TelegramPage.ID) or (PageID = AiPage.ID) or (PageID = KeyPage.ID) or (PageID = WorkPage.ID) then
    Result := FileExists(ExpandConstant('{app}\.env'));
  if (PageID = KeyPage.ID) and (AiPage.SelectedValueIndex = 2) then
    Result := True;
end;

function IsDigitsAndCommas(S: String): Boolean;
var
  I: Integer;
begin
  Result := True;
  for I := 1 to Length(S) do
    if not (((S[I] >= '0') and (S[I] <= '9')) or (S[I] = ',') or (S[I] = ' ') or (S[I] = '-')) then
      Result := False;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Token: String;
begin
  Result := True;
  // silent install: no questions; .env starts from .env.example (CurStepChanged)
  if WizardSilent then Exit;
  if CurPageID = TelegramPage.ID then
  begin
    Token := Trim(TelegramPage.Values[0]);
    if (Pos(':', Token) < 2) or (Length(Token) < 30) then
    begin
      MsgBox('Paste the bot token from @BotFather — it looks like 1234567890:AAH...', mbError, MB_OK);
      Result := False;
    end
    else if not IsDigitsAndCommas(Trim(TelegramPage.Values[1])) then
    begin
      MsgBox('The chat ID is a number (several: separated by commas). Leave it empty if you don''t know it yet.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  KillRunningApp;
  EnvWasThere := FileExists(ExpandConstant('{app}\.env'));
  Result := '';
end;

procedure WriteEnv;
var
  Lines: TArrayOfString;
  Provider, KeyLine: String;
begin
  case AiPage.SelectedValueIndex of
    0: begin Provider := 'ollama-cloud'; KeyLine := 'OLLAMA_CLOUD_API_KEY=' + Trim(KeyPage.Values[0]); end;
    1: begin Provider := 'anthropic'; KeyLine := 'ANTHROPIC_API_KEY=' + Trim(KeyPage.Values[0]); end;
  else
    begin Provider := 'ollama'; KeyLine := '# no API key needed for local Ollama'; end;
  end;
  ForceDirectories(WorkPage.Values[0]);
  SetArrayLength(Lines, 18);
  // first line is a comment: the file may start with a UTF-8 byte order mark
  Lines[0] := '# AiWindowsAssistant settings - written by Setup. All options: .env.example in this folder.';
  Lines[1] := 'TELEGRAM_BOT_TOKEN=' + Trim(TelegramPage.Values[0]);
  Lines[2] := 'TELEGRAM_ALLOWED_USERS=' + Trim(TelegramPage.Values[1]);
  Lines[3] := 'AI_PROVIDER=' + Provider;
  Lines[4] := KeyLine;
  Lines[5] := 'CLAUDE_WORKSPACE=' + WorkPage.Values[0];
  Lines[6] := 'DEFAULT_CWD=' + WorkPage.Values[0];
  Lines[7] := 'CLAUDE_PERMISSION_MODE=bypassPermissions';
  Lines[8] := 'AUTO_START=false';
  Lines[9] := 'TOAST_NOTIFICATIONS=true';
  Lines[10] := 'ALERTS=true';
  Lines[11] := 'CHAT_WINDOW=true';
  Lines[12] := 'CHAT_HOTKEY=Ctrl+Alt+Space';
  Lines[13] := 'TRUSTED_COMMANDS=';
  Lines[14] := 'SENSITIVE_PATHS=';
  Lines[15] := 'LOG_LEVEL=info';
  // Claude Code unless the owner opted into the assistant engine (Ollama Cloud) — switchable later with /engine and /workers
  if WizardIsTaskSelected('assistantengine') then
  begin
    Lines[16] := 'DEFAULT_ENGINE=assistant';
    Lines[17] := 'WORKER_ENGINE=assistant';
  end
  else
  begin
    Lines[16] := 'DEFAULT_ENGINE=claude';
    Lines[17] := 'WORKER_ENGINE=claude';
  end;
  EnvDone := SaveStringsToUTF8File(ExpandConstant('{app}\.env'), Lines, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not EnvWasThere then
  begin
    if WizardSilent then
      // unattended install: start from the example; the owner fills it in later
      FileCopy(ExpandConstant('{app}\.env.example'), ExpandConstant('{app}\.env'), True)
    else
      WriteEnv;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and not ClaudeCodeFound and not WizardIsTaskSelected('assistantengine') then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10 + #13#10 +
      'Claude Code was not found on this PC. The assistant works with its local engine, but for the full experience install Claude Code ' +
      '(https://claude.com/claude-code), run "claude" once to sign in, and start the assistant again.';
end;

function InitializeUninstall: Boolean;
begin
  KillRunningApp;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DirExists(ExpandConstant('{app}')) then
    if UninstallSilent or (MsgBox('Also delete your AiWindowsAssistant settings, history and logs?' + #13#10 + #13#10 +
       'Choose No to keep them for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDNO) then
      // keep .env, data and logs
    else
      DelTree(ExpandConstant('{app}'), True, True, True);
end;
