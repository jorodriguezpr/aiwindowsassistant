# Third-party notices

## SysAiBrain avatar

The talking avatar in the AiWindowsAssistant chat window is the **SysAiBrain** avatar —
https://sysaibrain.com — by Jose Rodriguez Arroyo.

- SysAiBrain is **commercial software**. It is **not** covered by the AiWindowsAssistant MIT
  license and its source code is not part of this repository.
- It is licensed **for use only as part of AiWindowsAssistant**, under its own terms:
  [SYSAIBRAIN-AVATAR-LICENSE.txt](SYSAIBRAIN-AVATAR-LICENSE.txt) (also shown by the installer).
  It may not be extracted, decrypted, modified, or used outside AiWindowsAssistant.
- It ships **only as an encrypted binary pack** (`assets/sysaibrain/avatar.bin`) inside the
  Windows installer and the release `.exe` — no source, model or other file that could be used to
  modify it. The pack can only be opened by the AiWindowsAssistant build it came with.
- Builds made from this repository's source do not include the avatar; the chat window then works
  without it.

Everything else in the chat window — voice, listening, spoken approvals, the conversation — is
AiWindowsAssistant's own code under its MIT license.

## Other components

AiWindowsAssistant's npm dependencies keep their own licenses (see `package.json` and each package
in `node_modules`).
