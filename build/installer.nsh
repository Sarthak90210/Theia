!macro customPageAfterChangeDir
  !include nsDialogs.nsh

  Page custom TheiaAppleDevicesPage

  Function TheiaAppleDevicesPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}

    ; Check installation, not whether the service happens to be running.
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\Apple Mobile Device Service" "ImagePath"
    ClearErrors
    ${If} $0 != ""
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Optional iPhone setup" "Install Apple Devices to connect an iPhone to Theia."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 32u "Apple Devices installs the Windows service and drivers that Theia uses for USB iPhone connections. You can skip this step if you use Android or local photo vaults."
    Pop $0
    ${NSD_CreateButton} 0 38u 115u 16u "Install Apple Devices"
    Pop $0
    ${NSD_OnClick} $0 TheiaOpenAppleDevices
    ${NSD_CreateLabel} 0 64u 100% 32u "Finish installing Apple Devices in the Microsoft Store. Then unlock the iPhone, reconnect it, and tap Trust if prompted. Select Install below to continue setting up Theia."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function TheiaOpenAppleDevices
    Pop $0 ; button handle
    ${StdUtils.ExecShellAsUser} $0 "ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K" "open" ""
    ${If} $0 != "ok"
    ${AndIf} $0 != "fallback"
      ExecShell "open" "https://apps.microsoft.com/detail/9np83lwlpz9k"
    ${EndIf}
  FunctionEnd
!macroend
